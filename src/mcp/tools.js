import { feishuService } from '../services/feishu.js';
import { didiService } from '../services/didi.js';
import { emailService } from '../services/email.js';
import { matcherService } from '../services/matcher.js';
import { logger } from '../services/logger.js';

/**
 * MCP Tool: list_hires
 * Returns filtered list of pre-hires
 */
export async function listHires({ location, date } = {}) {
  try {
    logger.info('MCP: Fetching pre-hires', { location, date });

    // Fetch and enrich pre-hires
    const preHires = await feishuService.getEnrichedPreHires();
    const withEmails = await emailService.batchGenerateEmails(preHires);
    const didiRules = await didiService.fetchRegulations();
    let enriched = matcherService.batchMatchRules(withEmails, didiRules);

    // Apply filters
    if (location) {
      const normalizedLocation = location.toLowerCase();
      enriched = enriched.filter(h => 
        h.city?.toLowerCase().includes(normalizedLocation)
      );
    }

    if (date) {
      enriched = enriched.filter(h => h.onboardingDate === date);
    }

    logger.success(`MCP: Found ${enriched.length} pre-hires`);

    return {
      success: true,
      total: enriched.length,
      filters: { location, date },
      data: enriched.map(h => ({
        id: h.id,
        name: h.name,
        phone: h.phone,
        city: h.city,
        department: h.department,
        onboarding_date: h.onboardingDate,
        suggested_email: h.suggested_email,
        suggested_didi_rule_id: h.suggested_didi_rule_id,
        suggested_didi_rule_name: h.suggested_didi_rule_name
      }))
    };
  } catch (error) {
    logger.error('MCP: Failed to list hires', { error: error.message });
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * MCP Tool: provision_employee
 * Executes provisioning for a single employee
 */
export async function provisionEmployee({ id, email, phone, didi_rule_id, name }) {
  try {
    logger.info(`MCP: Provisioning employee ${name || id}`);

    const result = {
      id,
      name,
      feishu: null,
      didi: null
    };

    // Provision Feishu email
    if (email && id) {
      try {
        logger.info(`MCP: Updating Feishu email`, { id, email });
        await feishuService.updateWorkEmail(id, email);
        result.feishu = { success: true, email };
        logger.success(`MCP: Feishu email updated`);
      } catch (error) {
        result.feishu = { success: false, error: error.message };
        logger.error(`MCP: Feishu email failed`, { error: error.message });
      }
    }

    // Provision Didi account
    if (phone && didi_rule_id && name) {
      try {
        logger.info(`MCP: Creating Didi account`, { name, phone });
        const didiResult = await didiService.addMember(name, phone, [didi_rule_id]);
        result.didi = { success: true, ...didiResult };
        logger.success(`MCP: Didi account created`);
      } catch (error) {
        result.didi = { success: false, error: error.message };
        logger.error(`MCP: Didi account failed`, { error: error.message });
      }
    }

    const overallSuccess = 
      (result.feishu?.success !== false) && 
      (result.didi?.success !== false);

    return {
      success: overallSuccess,
      data: result
    };
  } catch (error) {
    logger.error('MCP: Provisioning failed', { error: error.message });
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * MCP Tool: get_didi_rules
 * Returns all available Didi regulation rules
 */
export async function getDidiRules() {
  try {
    const rules = await didiService.fetchRegulations();
    return {
      success: true,
      total: rules.length,
      data: rules
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Tool definitions for MCP server
export const toolDefinitions = [
  {
    name: 'list_hires',
    description: 'List pre-hire employees with suggested email and Didi rules. Can filter by location and onboarding date.',
    inputSchema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'Filter by city/location name (e.g., "Beijing", "Shanghai")'
        },
        date: {
          type: 'string',
          description: 'Filter by onboarding date (YYYY-MM-DD format)'
        }
      }
    }
  },
  {
    name: 'provision_employee',
    description: 'Provision work email (Feishu) and corporate Didi account for an employee.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Pre-hire ID from Feishu'
        },
        name: {
          type: 'string',
          description: 'Employee name'
        },
        email: {
          type: 'string',
          description: 'Work email to assign'
        },
        phone: {
          type: 'string',
          description: 'Phone number (without +86 prefix)'
        },
        didi_rule_id: {
          type: 'string',
          description: 'Didi regulation rule ID to assign'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'get_didi_rules',
    description: 'Get all available Didi regulation rules for reference.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];
