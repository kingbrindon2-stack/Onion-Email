import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';

const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

async function testFeishu() {
  try {
    // Get token
    const tokenRes = await axios.post(`${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET
    });
    const token = tokenRes.data.tenant_access_token;
    console.log('✅ Token obtained!\n');

    // 测试 search 接口的各种参数
    console.log('Testing /corehr/v2/pre_hires/search with different params...\n');
    
    // 根据文档，search 接口支持的过滤参数
    const testParams = [
      { name: 'onboarding_status', body: { onboarding_status: 'preboarding' } },
      { name: 'onboarding_statuses array', body: { onboarding_statuses: ['preboarding'] } },
      { name: 'status', body: { status: 'preboarding' } },
      { name: 'statuses array', body: { statuses: ['preboarding'] } },
    ];
    
    for (const test of testParams) {
      console.log(`\nTrying: ${test.name}`);
      console.log('Body:', JSON.stringify(test.body));
      
      try {
        const res = await axios.post(
          `${FEISHU_BASE_URL}/corehr/v2/pre_hires/search?page_size=5`,
          test.body,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        const items = res.data.data?.items || [];
        console.log(`Result: ${items.length} items`);
        
        // 检查第一条的状态
        if (items.length > 0) {
          // 用 query 获取详情
          const detailRes = await axios.post(
            `${FEISHU_BASE_URL}/corehr/v2/pre_hires/query?page_size=1`,
            {
              fields: ['onboarding_info'],
              pre_hire_ids: [items[0].pre_hire_id]
            },
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            }
          );
          const status = detailRes.data.data?.items?.[0]?.onboarding_info?.onboarding_status;
          console.log(`First item status: ${status}`);
        }
      } catch (err) {
        console.log(`Error: ${err.response?.data?.msg || err.message}`);
      }
    }
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

testFeishu();
