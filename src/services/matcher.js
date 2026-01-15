class MatcherService {
  /**
   * Match Didi regulation rule based on user's city
   * @param {string} cityName - User's city name (e.g., "Beijing", "Wuhan")
   * @param {Array} allRules - All available Didi regulation rules
   * @returns {Object|null} - Matched rule or fallback
   */
  matchRule(cityName, allRules) {
    if (!allRules || allRules.length === 0) {
      return null;
    }

    if (!cityName || cityName === 'Unknown') {
      return allRules[0]; // Fallback to first rule
    }

    // Normalize city name for comparison
    const normalizedCity = cityName.toLowerCase().trim();

    // Try to find a rule that includes the city name
    const matchedRule = allRules.find(rule => {
      const ruleName = (rule.name || '').toLowerCase();
      return ruleName.includes(normalizedCity);
    });

    // Return matched rule or fallback to first rule
    return matchedRule || allRules[0];
  }

  /**
   * Batch match rules for multiple users
   * @param {Array} users - Array of user objects with city property
   * @param {Array} allRules - All available Didi regulation rules
   * @returns {Array} - Users with suggested_didi_rule_id added
   */
  batchMatchRules(users, allRules) {
    return users.map(user => {
      const matchedRule = this.matchRule(user.city, allRules);
      return {
        ...user,
        suggested_didi_rule_id: matchedRule?.id || null,
        suggested_didi_rule_name: matchedRule?.name || null
      };
    });
  }

  /**
   * Get rule by ID
   * @param {string} ruleId - Rule ID to find
   * @param {Array} allRules - All available rules
   * @returns {Object|null} - Found rule or null
   */
  getRuleById(ruleId, allRules) {
    return allRules.find(rule => rule.id === ruleId) || null;
  }
}

export const matcherService = new MatcherService();
