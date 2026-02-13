#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

import {
  toolDefinitions,
  listHires,
  provisionEmail,
  provisionEmailBatch,
  provisionDidi,
  getDidiRules,
  sendBotNotification,
  getAuditLog
} from './tools.js';

// Load environment variables
dotenv.config();

const server = new Server(
  {
    name: 'feishu-didi-onboarding',
    version: '2.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: toolDefinitions };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'list_hires':
        result = await listHires(args);
        break;
      case 'provision_email':
        result = await provisionEmail(args);
        break;
      case 'provision_email_batch':
        result = await provisionEmailBatch(args);
        break;
      case 'provision_didi':
        result = await provisionDidi(args);
        break;
      case 'get_didi_rules':
        result = await getDidiRules();
        break;
      case 'send_bot_notification':
        result = await sendBotNotification(args);
        break;
      case 'get_audit_log':
        result = await getAuditLog(args);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: error.message }, null, 2)
      }],
      isError: true
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Feishu-Didi Onboarding MCP Server v2.0 running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
