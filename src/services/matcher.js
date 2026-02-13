/**
 * 用车制度匹配服务
 * 
 * 根据员工所在城市自动匹配滴滴用车制度
 * 制度数据结构参考：https://opendocs.xiaojukeji.com/version2024/11313
 */
class MatcherService {
  /**
   * 根据城市名匹配用车制度
   * @param {string} cityName - 员工所在城市（如 "北京"、"Wuhan"）
   * @param {Array} allRules - 所有可用的制度列表
   * @returns {Object|null} - 匹配到的制度，或回退到默认制度
   */
  matchRule(cityName, allRules) {
    if (!allRules || allRules.length === 0) {
      return null;
    }

    // 只匹配状态为"正常"的制度
    const activeRules = allRules.filter(r => r.status === '1' || r.status === 1);
    if (activeRules.length === 0) {
      return null;
    }

    if (!cityName || cityName === 'Unknown') {
      // 无城市信息，尝试回退到"加班用车"场景(sceneType=3)的北京制度
      const fallback = activeRules.find(r => r.name.includes('北京') && String(r.sceneType) === '3');
      return fallback || activeRules[0];
    }

    const normalizedCity = cityName.toLowerCase().trim();

    // 优先匹配：制度名以"城市-加班用车"（最常用的新员工制度）
    // 优先选择名称最简洁的（如"北京-加班用车"优于"北京-直播用车（实习生早班）"）
    const overtimeCandidates = activeRules.filter(rule => {
      const ruleName = (rule.name || '').toLowerCase();
      return ruleName.startsWith(normalizedCity) && String(rule.sceneType) === '3';
    });
    if (overtimeCandidates.length > 0) {
      // 优先选"城市-加班用车"这种标准名称
      const standard = overtimeCandidates.find(r => r.name.match(/^.+-加班用车$/));
      return standard || overtimeCandidates.sort((a, b) => a.name.length - b.name.length)[0];
    }

    // 次优先：制度名包含城市名，且是商务出行（sceneType=1）
    const businessMatch = activeRules.find(rule => {
      const ruleName = (rule.name || '').toLowerCase();
      return ruleName.includes(normalizedCity) && String(rule.sceneType) === '1';
    });
    if (businessMatch) return businessMatch;

    // 再次：制度名包含城市名（任意场景）
    const anyMatch = activeRules.find(rule => {
      return (rule.name || '').toLowerCase().includes(normalizedCity);
    });
    if (anyMatch) return anyMatch;

    // 回退到北京-加班用车
    const fallback = activeRules.find(r => r.name.includes('北京') && String(r.sceneType) === '3');
    return fallback || activeRules[0];
  }

  /**
   * 批量匹配制度
   * @param {Array} users - 用户列表（需有 city 字段）
   * @param {Array} allRules - 所有可用的制度列表
   * @returns {Array} - 每个用户增加 suggested_didi_rule_id 和 suggested_didi_rule_name
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
   * 根据 ID 查找制度
   */
  getRuleById(ruleId, allRules) {
    return allRules.find(rule => rule.id === ruleId) || null;
  }

  /**
   * 构建制度 ID 字符串（多个制度用 _ 分隔，滴滴要求的格式）
   * @param {Array<string>} ruleIds - 制度 ID 数组
   * @returns {string} - "id1_id2_id3"
   */
  buildRegulationIdStr(ruleIds) {
    return ruleIds.filter(Boolean).join('_');
  }
}

export const matcherService = new MatcherService();
