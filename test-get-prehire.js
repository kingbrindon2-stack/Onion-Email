import dotenv from 'dotenv';
import { feishuService } from './src/services/feishu.js';

dotenv.config();

async function test() {
  try {
    // 先获取一个待入职人员ID
    const ids = await feishuService.fetchPreHires('preboarding');
    console.log('Got pre-hire IDs:', ids.slice(0, 3));
    
    if (ids.length > 0) {
      // 用 GET 接口获取单个待入职人员详情
      const preHireId = ids[0];
      console.log('\nFetching details for:', preHireId);
      
      // 试试查询待入职信息接口，看看有没有 offer_info
      const queryResult = await feishuService.request('POST', '/corehr/v2/pre_hires/query?page_size=1', {
        fields: ['person_info', 'employment_info', 'onboarding_info', 'offer_info'],
        pre_hire_ids: [preHireId]
      });
      console.log('\nQuery response:', JSON.stringify(queryResult, null, 2));
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

test();
