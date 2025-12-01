#!/usr/bin/env python3
"""
Integration tests for Python SDK

Run with: python test-sdk-python.py
"""

import asyncio
import sys
import os
from typing import List, Optional

# Add SDK to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'sdk', 'python'))

from entrez_sdk import EntrezSDK, EntrezSDKError


# ANSI color codes for pretty output
class Colors:
    RESET = '\033[0m'
    GREEN = '\033[32m'
    RED = '\033[31m'
    YELLOW = '\033[33m'
    BLUE = '\033[34m'
    CYAN = '\033[36m'


def log(message: str, color: str = 'RESET'):
    print(f"{getattr(Colors, color)}{message}{Colors.RESET}")


def log_section(title: str):
    print('\n' + '=' * 60)
    log(title, 'CYAN')
    print('=' * 60 + '\n')


def log_test(name: str):
    log(f"Testing: {name}", 'BLUE')


def log_success(message: str):
    log(f"✅ {message}", 'GREEN')


def log_error(message: str):
    log(f"❌ {message}", 'RED')


def log_warning(message: str):
    log(f"⚠️  {message}", 'YELLOW')


async def test_basic_connection(sdk: EntrezSDK) -> bool:
    """Test basic connection and API key status"""
    log_test('Basic connection and API key status')
    try:
        status = await sdk.get_api_key_status()
        log_success(f"Connected! Status retrieved")
        return True
    except EntrezSDKError as e:
        log_error(f"Connection failed: {e}")
        return False


async def test_capabilities(sdk: EntrezSDK) -> bool:
    """Test getting capabilities"""
    log_test('Get capabilities')
    try:
        capabilities = await sdk.get_capabilities(format='summary')
        log_success('Capabilities retrieved successfully')
        return True
    except EntrezSDKError as e:
        log_error(f"Capabilities failed: {e}")
        return False


async def test_search(sdk: EntrezSDK) -> Optional[List[str]]:
    """Test searching PubMed"""
    log_test('Search PubMed')
    try:
        results = await sdk.search('pubmed', 'CRISPR gene editing', retmax=3)
        if results.get('success') and results.get('idlist'):
            idlist = results['idlist']
            total = results.get('total_results', 0)
            log_success(f"Search successful: Found {total} results, returned {len(idlist)} IDs")
            log(f"  First ID: {idlist[0]}", 'BLUE')
            return idlist
        else:
            log_error('Search returned no results')
            return None
    except EntrezSDKError as e:
        log_error(f"Search failed: {e}")
        return None


async def test_summary(sdk: EntrezSDK, ids: List[str]) -> bool:
    """Test getting summaries"""
    log_test('Get summaries')
    try:
        summary = await sdk.summary('pubmed', ids[0], detail_level='brief')
        log_success('Summary retrieved successfully')
        return True
    except EntrezSDKError as e:
        log_error(f"Summary failed: {e}")
        return False


async def test_fetch(sdk: EntrezSDK, ids: List[str]) -> bool:
    """Test fetching abstract"""
    log_test('Fetch abstract')
    try:
        article = await sdk.fetch('pubmed', ids[0], rettype='abstract', detail_level='brief')
        log_success('Fetch successful')
        return True
    except EntrezSDKError as e:
        log_error(f"Fetch failed: {e}")
        return False


async def test_data_staging(sdk: EntrezSDK, ids: List[str]) -> bool:
    """Test data staging and SQL queries"""
    log_test('Data staging and SQL queries')
    try:
        # Stage data
        staging = await sdk.fetch_and_stage('pubmed', ids[:2])

        if not staging.data_access_id:
            log_error('Staging failed: No data_access_id returned')
            return False

        log_success(f"Data staged with ID: {staging.data_access_id[:16]}...")

        # Get schema
        schema = await staging.get_schema()
        table_names = schema.get('table_names', [])
        log_success(f"Schema retrieved: {', '.join(table_names)}")

        # Query data
        query_result = await staging.query('SELECT pmid, title FROM article LIMIT 2')

        if query_result.get('success') and query_result.get('row_count', 0) > 0:
            results = query_result['results']
            row_count = query_result['row_count']
            log_success(f"SQL query successful: {row_count} rows returned")
            if results:
                title = results[0].get('title', '')[:60]
                log(f"  First title: {title}...", 'BLUE')
            return True
        else:
            log_error('SQL query returned no results')
            return False
    except EntrezSDKError as e:
        log_error(f"Data staging failed: {e}")
        return False


async def test_pubchem(sdk: EntrezSDK) -> bool:
    """Test PubChem compound lookup"""
    log_test('PubChem compound lookup')
    try:
        compound = await sdk.get_compound('aspirin', 'name')
        log_success('PubChem lookup successful')
        return True
    except EntrezSDKError as e:
        log_error(f"PubChem failed: {e}")
        return False


async def test_error_handling(sdk: EntrezSDK) -> bool:
    """Test error handling with invalid database"""
    log_test('Error handling with invalid database')
    try:
        await sdk.search('invalid_database', 'test')
        log_error('Should have thrown an error for invalid database')
        return False
    except EntrezSDKError as e:
        error_msg = str(e).lower()
        if 'invalid database' in error_msg or 'invalid_database' in error_msg:
            log_success('Error handling works correctly')
            return True
        else:
            log_error(f"Unexpected error: {e}")
            return False


async def test_array_vs_string_ids(sdk: EntrezSDK, ids: List[str]) -> bool:
    """Test ID parameter handling (array vs string)"""
    log_test('ID parameter handling (list vs string)')
    try:
        # Test with list
        result1 = await sdk.summary('pubmed', ids[:2], detail_level='brief')

        # Test with comma-separated string
        result2 = await sdk.summary('pubmed', ','.join(ids[:2]), detail_level='brief')

        log_success('Both list and string ID formats work')
        return True
    except EntrezSDKError as e:
        log_error(f"ID format test failed: {e}")
        return False


async def test_async_context_manager(sdk: EntrezSDK) -> bool:
    """Test async context manager"""
    log_test('Async context manager')
    try:
        base_url = sdk.base_url
        async with EntrezSDK(base_url) as test_sdk:
            status = await test_sdk.get_api_key_status()
        log_success('Async context manager works correctly')
        return True
    except EntrezSDKError as e:
        log_error(f"Context manager test failed: {e}")
        return False


class TestResults:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.total = 0

    def record(self, success: bool):
        self.total += 1
        if success:
            self.passed += 1
        else:
            self.failed += 1
        print()

    @property
    def success_rate(self) -> float:
        return (self.passed / self.total * 100) if self.total > 0 else 0


async def run_all_tests():
    """Run all integration tests"""
    log_section('Entrez MCP Server - Python SDK Integration Tests')

    base_url = os.environ.get('BASE_URL', 'http://localhost:8787')
    log(f"Testing against: {base_url}", 'YELLOW')

    results = TestResults()

    async with EntrezSDK(base_url) as sdk:
        # Test suite
        log_section('1. Connection Tests')
        results.record(await test_basic_connection(sdk))
        results.record(await test_capabilities(sdk))
        results.record(await test_async_context_manager(sdk))

        log_section('2. Core E-utilities Tests')
        search_ids = await test_search(sdk)
        results.record(search_ids is not None)

        if search_ids and len(search_ids) > 0:
            results.record(await test_summary(sdk, search_ids))
            results.record(await test_fetch(sdk, search_ids))
            results.record(await test_array_vs_string_ids(sdk, search_ids))
        else:
            log_warning('Skipping summary, fetch, and ID format tests (no search results)')
            results.total += 3
            results.failed += 3

        log_section('3. Data Staging Tests')
        if search_ids and len(search_ids) > 0:
            results.record(await test_data_staging(sdk, search_ids))
        else:
            log_warning('Skipping data staging test (no search results)')
            results.total += 1
            results.failed += 1

        log_section('4. External API Tests')
        results.record(await test_pubchem(sdk))

        log_section('5. Error Handling Tests')
        results.record(await test_error_handling(sdk))

    # Final summary
    log_section('Test Summary')
    log(f"Total tests: {results.total}", 'BLUE')
    log(f"Passed: {results.passed}", 'GREEN')
    log(f"Failed: {results.failed}", 'RED' if results.failed > 0 else 'GREEN')

    success_rate = f"{results.success_rate:.1f}"
    log(f"\nSuccess rate: {success_rate}%", 'GREEN' if success_rate == '100.0' else 'YELLOW')

    if results.failed == 0:
        log('\n🎉 All tests passed!', 'GREEN')
        return 0
    else:
        log(f'\n⚠️  {results.failed} test(s) failed', 'RED')
        return 1


def main():
    """Main entry point"""
    try:
        exit_code = asyncio.run(run_all_tests())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        log('\n\nTests interrupted by user', 'YELLOW')
        sys.exit(130)
    except Exception as e:
        log_error(f"Fatal error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
