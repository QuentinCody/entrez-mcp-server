# NCBI API Key Setup Guide

## Overview

The Entrez MCP Server works out of the box without any configuration, but you can significantly improve performance by adding your free NCBI API key.

**Rate Limits:**
- **Without API Key**: 3 requests per second
- **With API Key**: 10 requests per second (3.3x faster!)

## Quick Start (No API Key Required)

The server works immediately without any setup:
```bash
# Works out of the box
npm start
```

## Performance Boost with API Key (Recommended)

### Step 1: Get Your Free API Key

1. Visit the [NCBI API Key Registration](https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/)
2. Click "API Key Settings" in your NCBI account
3. Generate a new API key (takes ~30 seconds)
4. Copy your API key (looks like: `1234567890abcdef1234567890abcdef1234`)

### Step 2: Configure Your API Key

Choose the method that works best for your setup:

#### Method 1: Environment Variable (Recommended)
```bash
# Set for current session
export NCBI_API_KEY="your_api_key_here"

# Or add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
echo 'export NCBI_API_KEY="your_api_key_here"' >> ~/.bashrc
```

#### Method 2: Cloudflare Workers Environment (Production)
```bash
# Set in wrangler.toml
npx wrangler secret put NCBI_API_KEY
# Enter your API key when prompted
```

#### Method 3: Local Development (.env file)
```bash
# Create .env file in project root
echo "NCBI_API_KEY=your_api_key_here" > .env
```

### Step 3: Verify It's Working

Run the test script to verify your API key is working:
```bash
node test-rate-limits.js
```

You should see output like:
```
✅ NCBI API Key found: 12345678...
🔍 Test 3: Authenticated Rate Limit (10 req/sec - should succeed with valid API key)
📊 Results:
   ✅ Successful: 50/50 (100.0%)
```

## Troubleshooting

### Common Issues

**"API key not found"**
- Check the environment variable: `echo $NCBI_API_KEY`
- Restart your terminal/server after setting the variable

**"Rate limiting still occurring"**
- Verify your API key is valid at [NCBI API Key Settings](https://www.ncbi.nlm.nih.gov/account/settings/)
- Check for typos in your API key
- Make sure there are no extra spaces or quotes

**"Request still slow"**
- API keys only affect rate limits, not individual request speed
- Network latency and NCBI server load also affect performance

### Testing Your Setup

Use our built-in rate limit tester:
```bash
# Test without API key (baseline)
unset NCBI_API_KEY
node test-rate-limits.js

# Test with API key
export NCBI_API_KEY="your_key_here" 
node test-rate-limits.js
```

## For Non-Technical Users

If you're not comfortable with command line:

1. **Just use it as-is** - The server works perfectly without any setup
2. **For better performance**: Ask a developer to help set up the API key using Method 1 above
3. **The improvement is optional** - You get 3x better rate limits, but it's not required

## Security Notes

- API keys are free and safe to use
- Never commit API keys to version control
- Each user should use their own API key
- Keys can be regenerated anytime at NCBI

## Need Help?

- Run `node test-rate-limits.js` to test your setup
- Check our troubleshooting section above
- Visit [NCBI E-utilities Help](https://www.ncbi.nlm.nih.gov/books/NBK25497/) for official documentation 