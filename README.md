# Feishu-Didi Onboarding Hub

Automates provisioning Work Emails (Feishu) and Corporate Didi Accounts for new hires. Functions as both a Web Dashboard and an MCP Server.

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Start web server
npm start

# Or start MCP server
npm run mcp
```

## Configuration

Create `.env` file with:

```env
FEISHU_APP_ID=your_feishu_app_id
FEISHU_APP_SECRET=your_feishu_app_secret
DIDI_CLIENT_ID=your_didi_client_id
DIDI_CLIENT_SECRET=your_didi_client_secret
DIDI_ACCESS_TOKEN=your_didi_access_token
PORT=3000
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/hires` | GET | Get enriched pre-hires list with suggested emails and Didi rules |
| `/api/didi/rules` | GET | Get all Didi regulation rules |
| `/api/provision` | POST | Execute provisioning for selected users |
| `/api/logs/stream` | GET | SSE endpoint for real-time logs |

## MCP Tools

- `list_hires({ location?, date? })` - List pre-hires with optional filters
- `provision_employee({ id, email, phone, didi_rule_id })` - Provision single employee
- `get_didi_rules()` - Get available Didi rules

## Architecture

```
src/
├── services/       # Business Logic
│   ├── feishu.js   # Feishu API (CoreHR V2)
│   ├── didi.js     # Didi Enterprise API
│   ├── email.js    # Pinyin email generation
│   ├── matcher.js  # Location-based rule matching
│   └── logger.js   # SSE logging service
├── api/
│   └── routes.js   # Express REST API
├── mcp/
│   ├── server.js   # MCP Server entry
│   └── tools.js    # MCP tool definitions
└── index.js        # Main entry point

public/
└── index.html      # Vue 3 + Element Plus Dashboard
```

## Features

- **Smart Email Generation**: Converts Chinese names to pinyin with automatic deduplication
- **Location-based Rule Matching**: Auto-suggests Didi rules based on employee city
- **Parallel Provisioning**: Feishu and Didi operations run concurrently
- **Real-time Logs**: SSE-powered log streaming to frontend
- **Graceful Error Handling**: Failures don't rollback successful operations
