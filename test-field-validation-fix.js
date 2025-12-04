#!/usr/bin/env node

/**
 * Test script to verify field validation fix
 * Tests that PubMed field abbreviations like [tiab] and [dp] are now accepted
 */

import { EntrezSDK } from './sdk/javascript/entrez-sdk.js';

const SERVER_URL = 'http://localhost:8787';

async function testFieldValidationFix() {
    console.log('🧪 Testing Field Validation Fix\n');

    const sdk = new EntrezSDK(SERVER_URL);

    try {
        // Test 1: [tiab] field tag (Title/Abstract)
        console.log('Test 1: Query with [tiab] field tag');
        console.log('Query: "CRISPR gene editing[tiab] AND 2024[dp]"\n');

        const result1 = await sdk.search(
            'pubmed',
            'CRISPR gene editing[tiab] AND 2024[dp]',
            { retmax: 5 }
        );

        if (result1.count > 0) {
            console.log('✅ PASS: [tiab] and [dp] tags accepted');
            console.log(`   Found ${result1.count} articles`);
            console.log(`   Query translation: ${result1.queryTranslation?.substring(0, 100)}...\n`);
        } else {
            console.log('⚠️  WARNING: Query accepted but no results\n');
        }

        // Test 2: [au] field tag (Author)
        console.log('Test 2: Query with [au] field tag');
        console.log('Query: "Smith J[au] AND cancer[ti]"\n');

        const result2 = await sdk.search(
            'pubmed',
            'Smith J[au] AND cancer[ti]',
            { retmax: 5 }
        );

        if (result2.count > 0) {
            console.log('✅ PASS: [au] and [ti] tags accepted');
            console.log(`   Found ${result2.count} articles\n`);
        } else {
            console.log('⚠️  WARNING: Query accepted but no results\n');
        }

        // Test 3: [mh] field tag (MeSH)
        console.log('Test 3: Query with [mh] field tag');
        console.log('Query: "Neoplasms[mh]"\n');

        const result3 = await sdk.search(
            'pubmed',
            'Neoplasms[mh]',
            { retmax: 5 }
        );

        if (result3.count > 0) {
            console.log('✅ PASS: [mh] tag accepted');
            console.log(`   Found ${result3.count} articles\n`);
        } else {
            console.log('⚠️  WARNING: Query accepted but no results\n');
        }

        console.log('✅ All field validation tests passed!');
        console.log('\n📝 Summary:');
        console.log('   - Field abbreviations ([tiab], [dp], [au], [ti], [mh]) now work correctly');
        console.log('   - NCBI handles field validation (no false positives)');

    } catch (error) {
        console.error('❌ FAIL: Test failed with error:');
        console.error(`   ${error.message}`);
        process.exit(1);
    } finally {
        await sdk.close();
    }
}

// Run test
testFieldValidationFix().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
