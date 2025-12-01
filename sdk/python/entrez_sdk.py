"""
Entrez MCP Server - Python SDK

This SDK provides a clean interface for calling MCP tools via code execution.
It handles parameter validation, error handling, and response formatting.

Usage:
    from entrez_sdk import EntrezSDK

    sdk = EntrezSDK('http://localhost:8787')
    results = await sdk.search('pubmed', 'CRISPR gene editing')
"""

import json
import time
from typing import Optional, Union, List, Dict, Any
from dataclasses import dataclass
import aiohttp
import asyncio


@dataclass
class SearchOptions:
    retmax: Optional[int] = 20
    retstart: Optional[int] = None
    sort: Optional[str] = None
    field: Optional[str] = None
    intended_use: Optional[str] = None


@dataclass
class SummaryOptions:
    retmax: Optional[int] = None
    compact_mode: Optional[bool] = None
    detail_level: Optional[str] = None
    max_tokens: Optional[int] = None


@dataclass
class FetchOptions:
    rettype: Optional[str] = None
    intended_use: Optional[str] = None
    detail_level: Optional[str] = None


class EntrezSDKError(Exception):
    """Base exception for Entrez SDK errors"""
    pass


class DataStaging:
    """Helper class for working with staged data"""

    def __init__(self, sdk: 'EntrezSDK', data_access_id: str, staging_result: Dict[str, Any]):
        self.sdk = sdk
        self.data_access_id = data_access_id
        self.staging_result = staging_result

    async def query(self, sql: str, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Query this staged dataset"""
        opts = options or {}
        return await self.sdk.query_staged_data(
            self.data_access_id,
            sql,
            intended_use=opts.get('intended_use'),
            max_tokens=opts.get('max_tokens'),
            response_style=opts.get('response_style', 'text'),
        )

    async def get_smart_summary(self, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Get smart summary of staged data"""
        opts = options or {}
        return await self.sdk.get_smart_summary(
            self.data_access_id,
            intended_use=opts.get('intended_use', 'analysis'),
            max_tokens=opts.get('max_tokens'),
        )

    async def get_schema(self) -> Dict[str, Any]:
        """Get schema for this staged dataset"""
        return await self.sdk.get_schema(self.data_access_id)

    def get_metadata(self) -> Dict[str, Any]:
        """Get the original staging result"""
        return self.staging_result


class EntrezSDK:
    """
    Main SDK class for interacting with Entrez MCP Server

    All methods use underscore naming (entrez_query, not entrez-query) for
    Python compatibility and code execution safety.
    """

    def __init__(self, base_url: str = 'http://localhost:8787'):
        """
        Initialize the SDK

        Args:
            base_url: Base URL of the MCP server (default: http://localhost:8787)
        """
        self.base_url = base_url.rstrip('/')
        self.session_id: Optional[str] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self.protocol_version = '2025-11-25'
        self.client_info = {'name': 'entrez-mcp-python', 'version': '1.0.0'}
        self.client_capabilities = {'tools': {}}

    async def __aenter__(self):
        """Async context manager entry"""
        self._session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit"""
        if self._session:
            await self._session.close()

    def _get_session(self) -> aiohttp.ClientSession:
        """Get or create aiohttp session"""
        if self._session is None:
            self._session = aiohttp.ClientSession()
        return self._session

    async def _call(self, tool_name: str, params: Dict[str, Any]) -> Any:
        """
        Make a raw MCP tool call

        Args:
            tool_name: Name of the tool to call (e.g., 'entrez_query')
            params: Parameters to pass to the tool

        Returns:
            Tool result

        Raises:
            EntrezSDKError: If the call fails
        """
        await self._ensure_session()
        cleaned_params = {k: v for k, v in params.items() if v is not None}
        return await self._request_payload(tool_name, 'tools/call', {
            'name': tool_name,
            'arguments': cleaned_params
        })

    def _format_context(self, context: str) -> str:
        stripped = context.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            return stripped
        return f'[{stripped}]'

    def _build_headers(self) -> Dict[str, str]:
        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'MCP-Protocol-Version': self.protocol_version
        }
        if self.session_id:
            headers['Mcp-Session-Id'] = self.session_id
        return headers

    def _extract_session_id(self, response: aiohttp.ClientResponse) -> None:
        new_session_id = response.headers.get('mcp-session-id')
        if new_session_id:
            self.session_id = new_session_id

    async def _request_payload(self, context: str, method: str, params: Dict[str, Any]) -> Any:
        payload = {
            'jsonrpc': '2.0',
            'id': int(time.time() * 1000),
            'method': method,
            'params': params
        }
        label = self._format_context(context)

        session = self._get_session()
        try:
            async with session.post(f"{self.base_url}/mcp", headers=self._build_headers(), json=payload) as response:
                self._extract_session_id(response)

                response_text = await response.text()

                if response.status >= 400:
                    message = response_text or response.reason
                    raise EntrezSDKError(f"{label} HTTP {response.status}: {message}")

                result = self._parse_response_text(response_text)

                if result and 'error' in result:
                    error_msg = result['error'].get('message', json.dumps(result['error']))
                    raise EntrezSDKError(f"{label} MCP Error: {error_msg}")

                payload = result.get('result') if isinstance(result, dict) else None

                if payload and isinstance(payload, dict) and self._is_error_payload(payload):
                    raise EntrezSDKError(f"{label} {self._format_payload_error(payload)}")

                normalized = payload
                if isinstance(payload, dict) and 'structuredContent' in payload:
                    structured = payload['structuredContent']
                    normalized = structured.copy() if isinstance(structured, dict) else structured
                    if 'content' in payload and isinstance(normalized, dict):
                        normalized = {
                            **normalized,
                            'content': payload['content']
                        }
                    elif 'content' in payload:
                        normalized = {
                            'content': payload['content']
                        }
                return normalized
        except aiohttp.ClientError as e:
            raise EntrezSDKError(f"{label} Network error: {str(e)}") from e
        except json.JSONDecodeError as e:
            raise EntrezSDKError(f"{label} Invalid JSON response: {str(e)}") from e

    async def _initialize_session(self) -> None:
        await self._request_payload('initialize', 'initialize', {
            'protocolVersion': self.protocol_version,
            'capabilities': self.client_capabilities,
            'clientInfo': self.client_info
        })

    async def _ensure_session(self) -> None:
        if self.session_id:
            return
        await self._initialize_session()

    def _parse_response_text(self, text: str) -> Dict[str, Any]:
        trimmed = text.strip()
        if not trimmed:
            return {}

        try:
            return json.loads(trimmed)
        except json.JSONDecodeError:
            return self._parse_sse_payload(trimmed)

    def _parse_sse_payload(self, text: str) -> Dict[str, Any]:
        normalized = text.replace('\r', '')
        segments = [segment.strip() for segment in normalized.split('\n\n') if segment.strip()]

        for segment in segments:
            data_lines = []
            for line in segment.splitlines():
                stripped = line.strip()
                if stripped.lower().startswith('data:'):
                    _, value = stripped.split(':', 1)
                    data_lines.append(value.lstrip())

            if not data_lines:
                continue

            payload = '\n'.join(data_lines)
            try:
                return json.loads(payload)
            except json.JSONDecodeError:
                continue

        raise EntrezSDKError('No JSON payload found in SSE response')

    def _is_error_payload(self, payload: Dict[str, Any]) -> bool:
        content = payload.get('content')
        if not isinstance(content, list):
            return False

        for block in content:
            if (
                isinstance(block, dict)
                and block.get('type') == 'text'
                and isinstance(block.get('text'), str)
                and block['text'].strip().startswith('❌')
            ):
                return True
        return False

    def _format_payload_error(self, payload: Dict[str, Any]) -> str:
        content = payload.get('content')
        if not isinstance(content, list):
            return 'Unknown error'

        for block in content:
            if (
                isinstance(block, dict)
                and block.get('type') == 'text'
                and isinstance(block.get('text'), str)
                and block['text'].strip().startswith('❌')
            ):
                return block['text'].strip()

        combined = ' '.join(
            block.get('text', '').strip()
            for block in content
            if isinstance(block, dict) and isinstance(block.get('text'), str)
        ).strip()
        return combined or 'Unknown error'

    # ========================================
    # SYSTEM TOOLS
    # ========================================

    async def get_api_key_status(self) -> Dict[str, Any]:
        """Check API key status and rate limits"""
        return await self._call('system_api_key_status', {})

    async def get_capabilities(self, format: str = 'summary', tool: Optional[str] = None,
                              include_metadata: bool = False) -> Dict[str, Any]:
        """Get tool capabilities"""
        return await self._call('entrez_capabilities', {
            'format': format,
            'tool': tool,
            'include_metadata': include_metadata
        })

    async def get_tool_info(self, tool_name: str, format: str = 'json') -> Dict[str, Any]:
        """Get detailed info about a specific tool"""
        return await self._call('entrez_tool_info', {
            'tool': tool_name,
            'format': format,
            'include_metadata': True
        })

    # ========================================
    # ENTREZ QUERY TOOLS (entrez_query)
    # ========================================

    async def search(self, database: str, term: str,
                    retmax: int = 20, retstart: Optional[int] = None,
                    sort: Optional[str] = None, field: Optional[str] = None,
                    intended_use: Optional[str] = None) -> Dict[str, Any]:
        """
        Search a database with a query term

        Args:
            database: Database to search (e.g., 'pubmed', 'protein')
            term: Search query
            retmax: Maximum results to return (default: 20)
            retstart: Starting position for pagination
            sort: Sort order
            field: Field restriction
            intended_use: Intended use hint ('search', 'analysis', 'citation', 'staging')

        Returns:
            Search results with IDs and metadata
        """
        return await self._call('entrez_query', {
            'operation': 'search',
            'database': database,
            'term': term,
            'retmax': retmax,
            'retstart': retstart,
            'sort': sort,
            'field': field,
            'intended_use': intended_use
        })

    async def summary(self, database: str, ids: Union[str, List[str]],
                     retmax: Optional[int] = None, compact_mode: bool = False,
                     detail_level: Optional[str] = None,
                     max_tokens: Optional[int] = None) -> Dict[str, Any]:
        """
        Get summaries for specific IDs

        Args:
            database: Database name
            ids: Single ID or list of IDs
            retmax: Maximum summaries to return
            compact_mode: Use compact formatting
            detail_level: Detail level ('brief', 'auto', 'full')
            max_tokens: Maximum tokens in response

        Returns:
            Summary data for the IDs
        """
        ids_str = ','.join(ids) if isinstance(ids, list) else str(ids)

        return await self._call('entrez_query', {
            'operation': 'summary',
            'database': database,
            'ids': ids_str,
            'retmax': retmax,
            'compact_mode': compact_mode,
            'detail_level': detail_level,
            'max_tokens': max_tokens
        })

    async def fetch(self, database: str, ids: Union[str, List[str]],
                   rettype: Optional[str] = None, intended_use: Optional[str] = None,
                   detail_level: Optional[str] = None) -> Dict[str, Any]:
        """
        Fetch detailed records for specific IDs

        Args:
            database: Database name
            ids: Single ID or list of IDs
            rettype: Return type (e.g., 'abstract', 'fasta', 'gb')
            intended_use: Intended use hint
            detail_level: Detail level

        Returns:
            Detailed record data
        """
        ids_str = ','.join(ids) if isinstance(ids, list) else str(ids)

        return await self._call('entrez_query', {
            'operation': 'fetch',
            'database': database,
            'ids': ids_str,
            'rettype': rettype,
            'intended_use': intended_use,
            'detail_level': detail_level
        })

    async def info(self, database: str) -> Dict[str, Any]:
        """Get database information"""
        return await self._call('entrez_query', {
            'operation': 'info',
            'database': database
        })

    async def link(self, database: str, ids: Union[str, List[str]],
                  dbfrom: Optional[str] = None, linkname: Optional[str] = None) -> Dict[str, Any]:
        """
        Find links between databases

        Args:
            database: Target database
            ids: Single ID or list of IDs
            dbfrom: Source database (if different from database)
            linkname: Specific link type

        Returns:
            Link data
        """
        ids_str = ','.join(ids) if isinstance(ids, list) else str(ids)

        return await self._call('entrez_query', {
            'operation': 'link',
            'database': database,
            'ids': ids_str,
            'dbfrom': dbfrom,
            'linkname': linkname
        })

    async def post(self, database: str, ids: Union[str, List[str]],
                  usehistory: str = 'y') -> Dict[str, Any]:
        """Post IDs to history server"""
        ids_str = ','.join(ids) if isinstance(ids, list) else str(ids)

        return await self._call('entrez_query', {
            'operation': 'post',
            'database': database,
            'ids': ids_str,
            'usehistory': usehistory
        })

    async def global_query(self, term: str) -> Dict[str, Any]:
        """Global query across all databases"""
        return await self._call('entrez_query', {
            'operation': 'global_query',
            'term': term
        })

    async def spell(self, term: str, database: str = 'pubmed') -> Dict[str, Any]:
        """Get spelling suggestions"""
        return await self._call('entrez_query', {
            'operation': 'spell',
            'database': database,
            'term': term
        })

    # ========================================
    # DATA STAGING TOOLS (entrez_data)
    # ========================================

    async def fetch_and_stage(self, database: str, ids: Union[str, List[str]],
                             rettype: str = 'xml', force_direct: bool = False,
                             include_raw: bool = False) -> DataStaging:
        """
        Fetch and stage data into SQL database

        Args:
            database: Database to fetch from
            ids: Single ID or list of IDs
            rettype: Return type (default: 'xml')
            force_direct: Force direct return instead of staging
            include_raw: Include raw data in response

        Returns:
            DataStaging object for querying the staged data
        """
        ids_str = ','.join(ids) if isinstance(ids, list) else str(ids)

        result = await self._call('entrez_data', {
            'operation': 'fetch_and_stage',
            'database': database,
            'ids': ids_str,
            'rettype': rettype,
            'force_direct': force_direct,
            'include_raw': include_raw
        })

        # Return DataStaging object for convenience
        if result.get('data_access_id'):
            return DataStaging(self, result['data_access_id'], result)

        return result

    async def query_staged_data(self, data_access_id: str, sql: str,
                               intended_use: Optional[str] = None,
                               max_tokens: Optional[int] = None,
                               response_style: str = 'text') -> Dict[str, Any]:
        """Query staged data with SQL"""
        return await self._call('entrez_data', {
            'operation': 'query',
            'data_access_id': data_access_id,
            'sql': sql,
            'intended_use': intended_use,
            'max_tokens': max_tokens,
            'response_style': response_style
        })

    async def get_smart_summary(self, data_access_id: str,
                               intended_use: str = 'analysis',
                               max_tokens: Optional[int] = None) -> Dict[str, Any]:
        """Get smart summary of staged data"""
        return await self._call('entrez_data', {
            'operation': 'query',
            'data_access_id': data_access_id,
            'smart_summary': True,
            'intended_use': intended_use,
            'max_tokens': max_tokens
        })

    async def get_schema(self, data_access_id: str) -> Dict[str, Any]:
        """Get schema for staged data"""
        return await self._call('entrez_data', {
            'operation': 'schema',
            'data_access_id': data_access_id
        })

    async def list_datasets(self) -> Dict[str, Any]:
        """List all staged datasets"""
        return await self._call('entrez_data', {
            'operation': 'list_datasets'
        })

    # ========================================
    # EXTERNAL APIS (entrez_external)
    # ========================================

    async def get_compound(self, identifier: str, identifier_type: str = 'name',
                          output_format: str = 'json') -> Dict[str, Any]:
        """Get PubChem compound data"""
        return await self._call('entrez_external', {
            'service': 'pubchem',
            'operation': 'compound',
            'identifier': identifier,
            'identifier_type': identifier_type,
            'output_format': output_format
        })

    async def get_substance(self, identifier: str, identifier_type: str = 'sid',
                           output_format: str = 'json') -> Dict[str, Any]:
        """Get PubChem substance data"""
        return await self._call('entrez_external', {
            'service': 'pubchem',
            'operation': 'substance',
            'identifier': identifier,
            'identifier_type': identifier_type,
            'output_format': output_format
        })

    async def get_bioassay(self, identifier: str, identifier_type: str = 'aid',
                          output_format: str = 'json') -> Dict[str, Any]:
        """Get PubChem bioassay data"""
        return await self._call('entrez_external', {
            'service': 'pubchem',
            'operation': 'bioassay',
            'identifier': identifier,
            'identifier_type': identifier_type,
            'output_format': output_format
        })

    async def structure_search(self, structure: str, structure_type: str,
                              search_type: str, threshold: int = 90,
                              max_records: int = 1000) -> Dict[str, Any]:
        """Search PubChem by chemical structure"""
        return await self._call('entrez_external', {
            'service': 'pubchem',
            'operation': 'structure_search',
            'structure': structure,
            'structure_type': structure_type,
            'search_type': search_type,
            'threshold': threshold,
            'max_records': max_records
        })

    async def convert_pmc_ids(self, ids: Union[str, List[str]],
                             versions: str = 'no') -> Dict[str, Any]:
        """Convert PMC IDs"""
        ids_str = ','.join(ids) if isinstance(ids, list) else str(ids)

        return await self._call('entrez_external', {
            'service': 'pmc',
            'operation': 'id_convert',
            'ids': ids_str,
            'versions': versions
        })

    async def get_pmc_article(self, id: str, output_format: str = 'xml') -> Dict[str, Any]:
        """Get PMC Open Access article"""
        return await self._call('entrez_external', {
            'service': 'pmc',
            'operation': 'oa_service',
            'id': id,
            'output_format': output_format
        })

    async def export_citations(self, ids: Union[str, List[str]],
                              citation_format: str = 'ris') -> Dict[str, Any]:
        """Export citations"""
        ids_str = ','.join(ids) if isinstance(ids, list) else str(ids)

        return await self._call('entrez_external', {
            'service': 'pmc',
            'operation': 'citation_export',
            'ids': ids_str,
            'citation_format': citation_format
        })

    async def close(self):
        """Close the aiohttp session"""
        if self._session:
            await self._session.close()
            self._session = None


# Convenience function for synchronous contexts
def create_sdk(base_url: str = 'http://localhost:8787') -> EntrezSDK:
    """Create an EntrezSDK instance"""
    return EntrezSDK(base_url)
