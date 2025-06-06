const { Telegraf } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// Khởi tạo bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Cấu hình Google Sheets
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const TASK_SHEET_ID = process.env.TASK_SHEET_ID;

// Danh sách user nhắc nhở (trong production nên lưu vào database)
const reminderUsers = new Set([
  5586005296 // User ID của bạn, có thể thêm nhiều user khác
]);

// Hàm lấy danh sách công việc
async function getTaskList() {
  try {
    const taskSheetId = TASK_SHEET_ID || process.env.GOOGLE_SHEET_ID;
    const taskDoc = new GoogleSpreadsheet(taskSheetId, serviceAccountAuth);
    
    await taskDoc.loadInfo();
    let sheet = taskDoc.sheetsByTitle['Ninh'] || taskDoc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    const tasks = [];
    for (const row of rows) {
      const task = {
        name: row.get('Đầu Việc'),
        deadline: row.get('Thời Gian Kết Thúc (Deadline)'),
        progress: row.get('Tiến Độ (%)') || 0,
        status: row.get('Trạng Thái'),
        notes: row.get('Ghi Chú / Vướng Mắc:')
      };
      
      if (task.name && task.name.trim() !== '') {
        tasks.push(task);
      }
    }
    
    return tasks;
  } catch (error) {
    console.error('Lỗi khi lấy danh sách công việc:', error);
    return [];
  }
}

// Hàm gửi nhắc nhở chi tiêu
async function sendExpenseReminder(hour) {
  let reminderMessage = '';
  const timeStr = `${hour}:00`;
  
  if (hour === 12) {
    reminderMessage = `🍱 GIỜ ĂN TRƯA RỒI! (${timeStr})\n\n📝 Hôm nay ăn gì? Nhớ ghi chi phí ăn uống nhé!\n\n💡 Ví dụ:\n• "Cơm văn phòng - 45k - tm"\n• "Ship đồ ăn - 80k - tk"`;
  } else if (hour === 18) {
    reminderMessage = `🌆 CUỐI NGÀY LÀM VIỆC! (${timeStr})\n\n📝 Hôm nay có chi tiêu gì khác không?\n\n💡 Có thể bạn quên:\n• "Café chiều - 30k - tm"\n• "Đổ xăng về nhà - 500k - tk"\n• "Mua đồ - 200k - tk"`;
  } else if (hour === 22) {
    reminderMessage = `🌙 TRƯỚC KHI NGỦ! (${timeStr})\n\n📝 Kiểm tra lại chi tiêu hôm nay nhé!\n\n💡 Đừng quên:\n• "Ăn tối - 100k - tm"\n• "Grab về nhà - 50k - tk"\n• "Mua thuốc - 80k - tm"`;
  }
  
  if (reminderMessage) {
    for (const userId of reminderUsers) {
      try {
        await bot.telegram.sendMessage(userId, reminderMessage);
      } catch (error) {
        console.error(`Lỗi gửi nhắc nhở chi tiêu cho user ${userId}:`, error);
      }
    }
  }
}

// Hàm gửi nhắc nhở công việc
async function sendTaskReminder(hour) {
  const timeStr = `${hour}:00`;
  const tasks = await getTaskList();
  
  let taskMessage = `📋 **NHẮC NHỞ CÔNG VIỆC** (${timeStr})\n\n`;
  
  const pendingTasks = tasks.filter(task => 
    task.status && !task.status.toLowerCase().includes('hoàn thành') && !task.status.toLowerCase().includes('hủy')
  );
  
  if (pendingTasks.length === 0) {
    taskMessage += `🎉 **Tuyệt vời!** Tất cả công việc đã hoàn thành!\n\n💪 Hãy tiếp tục duy trì hiệu suất cao nhé!`;
  } else {
    taskMessage += `📊 **Tổng quan:** ${pendingTasks.length} công việc đang thực hiện\n\n`;
    
    pendingTasks.slice(0, 5).forEach((task, index) => {
      taskMessage += `${index + 1}. **${task.name}**\n`;
      if (task.deadline) taskMessage += `   ⏰ Deadline: ${task.deadline}\n`;
      taskMessage += `   📊 Trạng thái: ${task.status}\n`;
      if (task.progress) taskMessage += `   📈 Tiến độ: ${task.progress}%\n`;
      if (task.notes) taskMessage += `   📝 Vướng mắc: ${task.notes}\n`;
      taskMessage += '\n';
    });
    
    if (pendingTasks.length > 5) {
      taskMessage += `📋 Và ${pendingTasks.length - 5} công việc khác...\n\n`;
    }
    
    taskMessage += `💡 Gõ /tasks để xem danh sách đầy đủ`;
  }
  
  for (const userId of reminderUsers) {
    try {
      await bot.telegram.sendMessage(userId, taskMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error(`Lỗi gửi nhắc nhở công việc cho user ${userId}:`, error);
    }
  }
}

// API endpoint chính
export default async function handler(req, res) {
  try {
    // Chỉ cho phép GET request
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    // Lấy giờ hiện tại theo múi giờ Việt Nam
    const now = new Date();
    const vietnamTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    const hour = vietnamTime.getHours();
    const minute = vietnamTime.getMinutes();
    
    console.log(`Cron job triggered at Vietnam time: ${vietnamTime.toLocaleString('vi-VN')} - Hour: ${hour}`);
    
    let actions = [];
    
    // Chỉ chạy vào phút 0 của mỗi giờ
    if (minute === 0) {
      // Gửi nhắc nhở chi tiêu vào 12:00, 18:00, 22:00
      if (hour === 12 || hour === 18 || hour === 22) {
        await sendExpenseReminder(hour);
        actions.push(`Sent expense reminder for ${hour}:00`);
      }
      
      // Gửi nhắc nhở công việc vào 7:00, 8:00, 9:00, 13:00, 18:00
      if (hour === 7 || hour === 8 || hour === 9 || hour === 13 || hour === 18) {
        await sendTaskReminder(hour);
        actions.push(`Sent task reminder for ${hour}:00`);
      }
    }
    
    res.status(200).json({
      success: true,
      time: vietnamTime.toLocaleString('vi-VN'),
      hour: hour,
      minute: minute,
      actions: actions,
      message: actions.length > 0 ? 'Reminders sent successfully' : 'No reminders scheduled for this time'
    });
    
  } catch (error) {
    console.error('Cron job error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
