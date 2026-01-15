import 'dotenv/config';
import { feishuService } from './src/services/feishu.js';

async function test() {
  try {
    // 查询杨雨薇的详细信息 (刚才更新的)
    const preHireId = '7584911421886301723';
    
    const result = await feishuService.request('POST', '/corehr/v2/pre_hires/query?page_size=1', {
      fields: ['person_info', 'employment_info', 'onboarding_info', 'offer_info'],
      pre_hire_ids: [preHireId]
    });
    
    const item = result.data?.items?.[0];
    if (item) {
      console.log('=== Employment Info ===');
      console.log('work_email:', item.employment_info?.work_email);
      
      console.log('\n=== Onboarding Info ===');
      console.log('onboarding_status:', item.onboarding_info?.onboarding_status);
      console.log('onboarding_task_list:');
      item.onboarding_info?.onboarding_task_list?.forEach(task => {
        console.log(`  - ${task.task_name}: ${task.task_status}`);
      });
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

test();
