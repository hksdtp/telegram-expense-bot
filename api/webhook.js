const { Telegraf } = require('telegraf');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const util = require('util');
const stream = require('stream');

const pipeline = util.promisify(stream.pipeline);

// Xác thực Google APIs
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
  ],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
const drive = google.drive({ version: 'v3', auth: serviceAccountAuth });

// Cấu hình danh mục
const categories = {
  'chi phí xe ô tô': { emoji: '🚗', subcategories: ['xăng', 'rửa xe', 'vetc', 'sửa chữa', 'vé đỗ xe'] },
  'xăng': { emoji: '⛽', subcategories: ['xăng', 'nhiên liệu'] },
  'rửa xe': { emoji: '🧽', subcategories: ['rửa xe', 'vệ sinh xe'] },
  'vetc': { emoji: '🎫', subcategories: ['vetc', 'thu phí không dừng'] },
  'nhà hàng': { emoji: '🍽️', subcategories: ['ăn sáng', 'ăn trưa', 'ăn tối', 'café'] },
  'ăn sáng': { emoji: '🍳', subcategories: ['phở', 'bánh mì', 'cơm'] },
  'ăn trưa': { emoji: '🍱', subcategories: ['cơm', 'bún', 'phở'] },
  'ăn tối': { emoji: '🍽️', subcategories: ['cơm', 'lẩu', 'nướng'] },
  'café': { emoji: '☕', subcategories: ['cà phê', 'trà', 'nước'] },
  'giao nhận đồ': { emoji: '📦', subcategories: ['giao đồ', 'ship đồ', 'grab food'] },
  'ship đồ': { emoji: '📮', subcategories: ['phí ship', 'giao hàng'] },
  'mua đồ': { emoji: '🛒', subcategories: ['quần áo', 'giày dép', 'mỹ phẩm'] },
  'dịch vụ': { emoji: '🔧', subcategories: ['cắt tóc', 'massage', 'spa'] },
  'chi phí khác': { emoji: '💰', subcategories: ['khác', 'linh tinh'] },
  'thu nhập': { emoji: '💵', subcategories: ['lương', 'thưởng', 'ứng'] },
  'hoàn về': { emoji: '💸', subcategories: ['tài khoản', 'hoàn tiền', 'refund'] }
};

const paymentMethods = {
  'tk': 'Chuyển khoản',
  'ck': 'Chuyển khoản',
  'chuyển khoản': 'Chuyển khoản',
  'banking': 'Chuyển khoản',
  'tm': 'Tiền mặt',
  'tiền mặt': 'Tiền mặt',
  'cash': 'Tiền mặt'
};

// Hàm phân tích ngày tháng
function parseDateTime(text) {
  const input = text.toLowerCase();
  const now = new Date();
  let targetDate = new Date(now);

  // Regex cho các pattern ngày tháng
  const monthPattern = /tháng\s*(\d{1,2})/;
  const dayPattern = /ngày\s*(\d{1,2})/;
  const datePattern = /(\d{1,2})\/(\d{1,2})/; // dd/mm

  const monthMatch = input.match(monthPattern);
  const dayMatch = input.match(dayPattern);
  const dateMatch = input.match(datePattern);

  if (dateMatch) {
    // Format dd/mm
    const day = parseInt(dateMatch[1]);
    const month = parseInt(dateMatch[2]) - 1; // JavaScript month is 0-based
    targetDate.setDate(day);
    targetDate.setMonth(month);
  } else {
    if (monthMatch) {
      const month = parseInt(monthMatch[1]) - 1;
      targetDate.setMonth(month);
      // Nếu tháng đã qua trong năm nay, chuyển sang năm sau
      if (targetDate < now) {
        targetDate.setFullYear(now.getFullYear() + 1);
      }
    }

    if (dayMatch) {
      const day = parseInt(dayMatch[1]);
      targetDate.setDate(day);
      // Nếu ngày đã qua trong tháng này, chuyển sang tháng sau
      if (targetDate < now) {
        targetDate.setMonth(targetDate.getMonth() + 1);
      }
    }
  }

  return targetDate;
}

// Hàm phân tích chi tiêu cải tiến
function parseExpense(text) {
  const input = text.toLowerCase().trim();
  let originalText = text.trim();

  // Phân tích ngày tháng
  const customDate = parseDateTime(text);

  // Kiểm tra xem có sử dụng format với dấu - không
  const hasDashFormat = text.includes(' - ');
  let description = '';
  let amount = 0;
  let amountText = '';
  let paymentMethodFromText = '';

  if (hasDashFormat) {
    // Xử lý format: "mô tả - số tiền - số lượng - phương thức"
    const parts = originalText.split(' - ').map(part => part.trim());

    if (parts.length >= 2) {
      description = parts[0]; // Phần đầu là mô tả

      // Tìm số tiền, số lượng và phương thức trong các phần còn lại
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];

        // Kiểm tra xem có phải số tiền không
        const amountRegex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(k|tr|nghìn|triệu|đ|đồng|d|vnd)?\b/gi;
        const amountMatch = part.match(amountRegex);

        // Kiểm tra xem có phải số lượng không (ví dụ: 70L, 5kg, 10 cái)
        const quantityRegex = /(\d+(?:[.,]\d+)?)\s*(l|lít|kg|g|gram|cái|chiếc|ly|chai|hộp|gói|túi|m|cm|km)\b/gi;
        const quantityMatch = part.match(quantityRegex);

        if (amountMatch && amountMatch.length > 0 && !quantityMatch) {
          // Đây là số tiền
          const match = amountMatch[0];
          const numberMatch = match.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)/);
          const unitMatch = match.match(/(k|tr|nghìn|triệu|đ|đồng|d|vnd)/i);

          if (numberMatch) {
            let value = parseFloat(numberMatch[1].replace(/\./g, '').replace(/,/g, '.'));
            const unit = unitMatch ? unitMatch[1].toLowerCase() : '';

            if (unit.includes('k') || unit.includes('nghìn')) value *= 1000;
            else if (unit.includes('tr') || unit.includes('triệu')) value *= 1000000;

            amount = value;
            amountText = match;
          }
        } else if (quantityMatch && quantityMatch.length > 0) {
          // Đây là số lượng
          const match = quantityMatch[0];
          const numberMatch = match.match(/(\d+(?:[.,]\d+)?)/);
          if (numberMatch) {
            quantity = parseFloat(numberMatch[1]);
          }
        } else if (!amountMatch && !quantityMatch && part.length <= 10) {
          // Có thể là phương thức thanh toán
          paymentMethodFromText = part;
        }
      }
    }
  } else {
    // Xử lý format cũ
    const amountRegex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(k|tr|nghìn|triệu|đ|đồng|d|vnd)?\b/gi;
    const amountMatches = [...input.matchAll(amountRegex)];

    // Tìm số tiền hợp lệ nhất (lớn nhất)
    for (const match of amountMatches) {
      let value = parseFloat(match[1].replace(/\./g, '').replace(/,/g, '.'));
      const unit = match[2] ? match[2].toLowerCase() : '';

      if (unit.includes('k') || unit.includes('nghìn')) value *= 1000;
      else if (unit.includes('tr') || unit.includes('triệu')) value *= 1000000;

      if (value > amount) {
        amount = value;
        amountText = match[0];
      }
    }

    // Loại bỏ số tiền khỏi mô tả
    description = originalText.replace(amountText, '').trim();
  }

  let category = 'Chi phí khác';
  let emoji = '💰';
  let subcategory = 'Khác';
  let paymentMethod = 'Tiền mặt';
  let quantity = 1;
  let type = 'Chi';

  // Phát hiện loại giao dịch
  const incomeKeywords = ['thu', 'nhận', 'lương', 'ứng'];
  const refundKeywords = ['hoàn'];

  if (refundKeywords.some(keyword => input.includes(keyword))) {
    type = 'Thu';
    category = 'Hoàn về';
    emoji = '💸';
    subcategory = 'Tài khoản';

    // Tạo mô tả chi tiết cho hoàn tiền
    if (description.toLowerCase().includes('hoàn')) {
      const cleanDesc = description.replace(/\d+[\s]*[ktr]*[\s]*(nghìn|triệu|đ|đồng|d|vnd)*/gi, '').trim();
      if (cleanDesc.length > 0) {
        description = `Hoàn về tài khoản - ${cleanDesc}`;
      } else {
        description = 'Hoàn về tài khoản';
      }
    }
  } else if (incomeKeywords.some(keyword => input.includes(keyword))) {
    type = 'Thu';
    category = 'Thu nhập';
    emoji = '💵';
  } else {
    // Xác định danh mục với ưu tiên cho danh mục cha
    let bestMatch = '';
    let matchLength = 0;
    let isParentCategory = false;

    // Kiểm tra các từ khóa đặc biệt cho xe ô tô
    const carKeywords = ['xăng', 'rửa xe', 'vetc', 'range rover', 'xe', 'ô tô'];
    const hasCarKeyword = carKeywords.some(keyword => input.includes(keyword));

    if (hasCarKeyword) {
      // Ưu tiên danh mục "chi phí xe ô tô"
      category = 'Chi phí xe ô tô';
      emoji = categories['chi phí xe ô tô'].emoji;

      // Xác định danh mục con dựa trên từ khóa
      if (input.includes('xăng')) {
        subcategory = 'Xăng';
      } else if (input.includes('rửa xe')) {
        subcategory = 'Rửa xe';
      } else if (input.includes('vetc')) {
        subcategory = 'Vetc';
      } else if (input.includes('sửa chữa') || input.includes('sửa')) {
        subcategory = 'Sửa chữa';
      } else if (input.includes('đỗ xe') || input.includes('vé đỗ')) {
        subcategory = 'Vé đỗ xe';
      } else {
        subcategory = 'Khác';
      }
    } else {
      // Logic phân loại thông thường
      for (const cat in categories) {
        if (input.includes(cat) && cat.length > matchLength) {
          bestMatch = cat;
          matchLength = cat.length;
        }
      }

      if (bestMatch) {
        category = bestMatch.charAt(0).toUpperCase() + bestMatch.slice(1);
        emoji = categories[bestMatch].emoji;

        // Xác định danh mục con
        for (const sub of categories[bestMatch].subcategories) {
          if (input.includes(sub)) {
            subcategory = sub.charAt(0).toUpperCase() + sub.slice(1);
            break;
          }
        }
      }
    }
    
    // Xác định phương thức thanh toán
    if (paymentMethodFromText) {
      // Ưu tiên phương thức từ format có dấu -
      for (const method in paymentMethods) {
        if (paymentMethodFromText.toLowerCase().includes(method)) {
          paymentMethod = paymentMethods[method];
          break;
        }
      }
    } else {
      // Tìm trong toàn bộ text
      for (const method in paymentMethods) {
        if (input.includes(method)) {
          paymentMethod = paymentMethods[method];
          break;
        }
      }
    }
  }

  return {
    amount,
    category,
    emoji,
    subcategory,
    paymentMethod,
    quantity,
    type,
    description,
    customDate
  };
}

// Tìm hoặc tạo thư mục theo tháng và năm
async function findOrCreateMonthYearFolder(year, month) {
  try {
    const parentFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const folderName = `${year}_${month}`;
    
    // Tìm thư mục nếu đã tồn tại
    const searchResponse = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentFolderId}' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });
    
    // Nếu thư mục đã tồn tại, trả về ID
    if (searchResponse.data.files.length > 0) {
      return searchResponse.data.files[0].id;
    }
    
    // Nếu chưa tồn tại, tạo thư mục mới
    const folderMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId]
    };
    
    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id'
    });
    
    return folder.data.id;
  } catch (error) {
    console.error('Lỗi khi tìm/tạo thư mục:', error);
    // Trả về thư mục gốc nếu có lỗi
    return process.env.GOOGLE_DRIVE_FOLDER_ID;
  }
}

// Upload ảnh lên Google Drive theo tháng/năm
async function uploadImageToDrive(filePath, fileName) {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0'); // Tháng từ 01-12
    
    // Tìm hoặc tạo thư mục tháng/năm
    const folderId = await findOrCreateMonthYearFolder(year, month);
    
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: 'image/jpeg',
        parents: [folderId],
      },
      media: {
        mimeType: 'image/jpeg',
        body: fs.createReadStream(filePath),
      },
    });

    // Cấp quyền truy cập công khai
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    // Lấy link chia sẻ
    const result = await drive.files.get({
      fileId: response.data.id,
      fields: 'webViewLink',
    });

    return result.data.webViewLink;
  } catch (error) {
    console.error('Lỗi khi upload ảnh:', error);
    return null;
  } finally {
    // Xóa file tạm
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error('Lỗi khi xóa file tạm:', err);
    }
  }
}

// Gửi thông báo lên Channel/Group
async function sendToChannelOrGroup(expenseData, username, imageUrl = '') {
  const targetDate = expenseData.customDate || new Date();
  const dateStr = targetDate.toLocaleDateString('vi-VN');

  let message = `💰 **GIAO DỊCH MỚI**\n\n`;
  message += `${expenseData.emoji} **${expenseData.category}**\n`;
  message += `📝 ${expenseData.description}\n`;
  message += `💰 ${expenseData.amount.toLocaleString('vi-VN')} ₫\n`;

  // Hiển thị số lượng nếu khác 1
  if (expenseData.quantity && expenseData.quantity !== 1) {
    message += `📊 Số lượng: ${expenseData.quantity}\n`;
  }

  message += `💳 ${expenseData.paymentMethod}\n`;
  message += `📅 ${dateStr}\n`;
  message += `👤 ${username}`;

  if (imageUrl) {
    message += `\n📎 [Xem hóa đơn](${imageUrl})`;
  }

  // Gửi lên Channel nếu có
  if (CHANNEL_ID) {
    try {
      await bot.telegram.sendMessage(CHANNEL_ID, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    } catch (error) {
      console.error('Lỗi khi gửi lên Channel:', error);
    }
  }

  // Gửi lên Group nếu có
  if (GROUP_ID) {
    try {
      await bot.telegram.sendMessage(GROUP_ID, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    } catch (error) {
      console.error('Lỗi khi gửi lên Group:', error);
    }
  }
}

// Lưu dữ liệu vào Google Sheets
async function saveToSheet(userId, username, expenseData, imageUrl = '') {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    const now = new Date();
    const targetDate = expenseData.customDate || now;
    const dateStr = targetDate.toLocaleDateString('vi-VN');
    const isoTime = targetDate.toISOString();

    await sheet.addRow({
      'Ngày': dateStr,
      'Danh mục': expenseData.category,
      'Mô tả': expenseData.description,
      'Số tiền': expenseData.amount,
      'Loại': expenseData.type === 'Chi' ? 'expense' : 'income',
      'Link hóa đơn': imageUrl,
      'Thời gian': isoTime,
      'Danh mục phụ': expenseData.subcategory,
      'Số lượng': expenseData.quantity,
      'Phương thức thanh toán': expenseData.paymentMethod,
      'Ghi chú': `${username} (${userId})`
    });

    // Gửi thông báo lên Channel/Group sau khi lưu thành công
    // await sendToChannelOrGroup(expenseData, username, imageUrl); // Tạm tắt để tránh trùng lặp

    return true;
  } catch (error) {
    console.error('Lỗi khi lưu vào sheet:', error);
    return false;
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Danh sách user ID để nhắc nhở (có thể lưu vào database sau)
const reminderUsers = new Set([
  5586005296 // User ID của Ninh - hardcode để đảm bảo hoạt động
]);

// Channel ID để gửi thông báo (thêm vào environment variables)
const CHANNEL_ID = process.env.CHANNEL_ID;

// Group ID để gửi thông báo (thêm vào environment variables)
const GROUP_ID = process.env.GROUP_ID;

// Topic IDs cho phân biệt chức năng
const EXPENSE_TOPIC_ID = process.env.EXPENSE_TOPIC_ID; // Topic Chi tiêu
const TASK_TOPIC_ID = process.env.TASK_TOPIC_ID; // Topic Nhắc công việc

// Google Sheets ID cho công việc (riêng biệt với chi tiêu)
const TASK_SHEET_ID = process.env.TASK_SHEET_ID;

// Hàm lấy danh sách công việc từ Google Sheets
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
        stt: row.get('STT'),
        name: row.get('Đầu Việc'),
        description: row.get('Mô Tả Chi Tiết'),
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

// Hàm gửi nhắc nhở thông minh
async function sendSmartReminder() {
  const now = new Date();
  const hour = now.getHours();
  const timeStr = now.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh'
  });

  let reminderMessage = '';

  // Tùy chỉnh tin nhắn theo thời gian
  if (hour === 12) {
    reminderMessage = `🍱 GIỜ ĂN TRƯA RỒI! (${timeStr})\n\n📝 Hôm nay ăn gì? Nhớ ghi chi phí ăn uống nhé!\n\n💡 Ví dụ:\n• "Cơm văn phòng - 45k - tm"\n• "Ship đồ ăn - 80k - tk"`;
  } else if (hour === 18) {
    reminderMessage = `🌆 CUỐI NGÀY LÀM VIỆC! (${timeStr})\n\n📝 Hôm nay có chi tiêu gì khác không?\n\n💡 Có thể bạn quên:\n• "Café chiều - 30k - tm"\n• "Đổ xăng về nhà - 500k - tk"\n• "Mua đồ - 200k - tk"`;
  } else if (hour === 22) {
    reminderMessage = `🌙 TRƯỚC KHI NGỦ! (${timeStr})\n\n📝 Kiểm tra lại chi tiêu hôm nay nhé!\n\n💡 Đừng quên:\n• "Ăn tối - 100k - tm"\n• "Grab về nhà - 50k - tk"\n• "Mua thuốc - 80k - tm"`;
  }

  for (const userId of reminderUsers) {
    try {
      await bot.telegram.sendMessage(userId, reminderMessage);
    } catch (error) {
      console.error(`Lỗi gửi nhắc nhở cho user ${userId}:`, error);
      // Xóa user nếu bot bị block
      if (error.code === 403) {
        reminderUsers.delete(userId);
      }
    }
  }
}

// Hàm gửi nhắc nhở công việc
async function sendTaskReminder() {
  const now = new Date();
  const hour = now.getHours();
  const timeStr = now.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh'
  });

  const tasks = await getTaskList();

  if (tasks.length === 0) {
    return; // Không có công việc thì không gửi nhắc nhở
  }

  let taskMessage = `📋 **NHẮC NHỞ CÔNG VIỆC** (${timeStr})\n\n`;

  // Lọc công việc chưa hoàn thành
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
      if (error.code === 403) {
        reminderUsers.delete(userId);
      }
    }
  }
}

// Hàm kiểm tra và gửi nhắc nhở theo giờ
function checkAndSendReminder() {
  const now = new Date();

  // Chuyển đổi sang múi giờ Việt Nam (UTC+7)
  const vietnamTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
  const hour = vietnamTime.getHours();
  const minute = vietnamTime.getMinutes();

  console.log(`Current Vietnam time: ${vietnamTime.toLocaleString('vi-VN')} - Hour: ${hour}, Minute: ${minute}`);
  console.log(`Reminder users count: ${reminderUsers.size}`);

  if (minute === 0) {
    console.log(`Checking reminders for hour: ${hour}`);

    // Gửi nhắc nhở chi tiêu vào 12:00, 18:00, 22:00
    if (hour === 12 || hour === 18 || hour === 22) {
      console.log(`Sending expense reminder for hour: ${hour}`);
      sendSmartReminder();
    }

    // Gửi nhắc nhở công việc vào 7:00, 8:00, 9:00, 13:00, 18:00
    if (hour === 7 || hour === 8 || hour === 9 || hour === 13 || hour === 18) {
      console.log(`Sending task reminder for hour: ${hour}`);
      sendTaskReminder();
    }
  }
}

// Thiết lập interval để kiểm tra mỗi phút
setInterval(checkAndSendReminder, 60000);

// Lệnh test nhắc nhở ngay lập tức
bot.command('test_reminder', async (ctx) => {
  const userId = ctx.from.id;
  reminderUsers.add(userId);

  const initialMsg = await ctx.reply('🧪 **TEST NHẮC NHỞ**\n\nĐang gửi test nhắc nhở chi tiêu và công việc...');

  try {
    // Test nhắc nhở chi tiêu
    await ctx.reply('🧪 **TEST NHẮC NHỞ CHI TIÊU**\n\n📝 Đây là test nhắc nhở chi tiêu!\n\n💡 Ví dụ: "Ăn trưa - 50k - tm"');

    // Test nhắc nhở công việc
    try {
      const tasks = await getTaskList();
      let taskMessage = '🧪 **TEST NHẮC NHỞ CÔNG VIỆC**\n\n';

      if (tasks.length === 0) {
        taskMessage += '📋 Hiện tại không có công việc nào!\n\n💡 Gõ /cv để tạo công việc mới';
      } else {
        taskMessage += `📊 Có ${tasks.length} công việc trong danh sách\n\n`;
        tasks.slice(0, 3).forEach((task, index) => {
          taskMessage += `${index + 1}. **${task.name}**\n`;
          if (task.deadline) taskMessage += `   ⏰ ${task.deadline}\n`;
          taskMessage += `   📊 ${task.status || 'Chưa xác định'}\n\n`;
        });

        if (tasks.length > 3) {
          taskMessage += `📋 Và ${tasks.length - 3} công việc khác...\n\n`;
        }

        taskMessage += `💡 Gõ /tasks để xem danh sách đầy đủ`;
      }

      await ctx.reply(taskMessage, { parse_mode: 'Markdown' });
    } catch (taskError) {
      console.error('Lỗi test nhắc nhở công việc:', taskError);
      await ctx.reply('❌ **LỖI TEST CÔNG VIỆC**\n\nKhông thể truy cập Google Sheets!\n\n🔧 Kiểm tra:\n• TASK_SHEET_ID có đúng không?\n• Quyền truy cập Google Sheets\n• Kết nối internet');
    }

    // Cập nhật tin nhắn đầu
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      initialMsg.message_id,
      null,
      '✅ **TEST NHẮC NHỞ HOÀN THÀNH**\n\nĐã gửi test nhắc nhở chi tiêu và công việc!'
    );

  } catch (error) {
    console.error('Lỗi test nhắc nhở:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      initialMsg.message_id,
      null,
      '❌ **LỖI TEST NHẮC NHỞ**\n\nCó lỗi xảy ra khi test!'
    );
  }
});

// Xử lý lệnh /start
bot.start((ctx) => {
  const userId = ctx.from.id;
  reminderUsers.add(userId); // Tự động đăng ký nhắc nhở

  ctx.reply(`👋 Xin chào ${ctx.from.first_name}!\n\n📝 Nhập chi tiêu theo cú pháp:\n"Mô tả [số tiền] [phương thức]\n\nVí dụ: "Phở bò 55k tm" hoặc "Ứng 5 triệu tk"`);
});

// Xử lý lệnh /help
bot.help((ctx) => {
  ctx.reply(`📖 HƯỚNG DẪN SỬ DỤNG:\n\n🏷️ **TOPIC CHI TIÊU:**\n1. Format cơ bản:\n"Ăn sáng 50k tm"\n"Xăng xe 500k tk"\n\n2. Format có dấu gạch ngang:\n"Mô tả - Số tiền - Phương thức"\n"Thanh toán sân pickleball - 2tr - tk"\n\n3. Format với số lượng:\n"Đổ xăng - 1tr - 70L - tk"\n"Mua nước - 50k - 5 chai - tm"\n\n4. Thu nhập/Hoàn tiền:\n"Lương tháng 15 triệu tk"\n"Hoàn 200k tm"\n\n5. Hỗ trợ ngày tháng:\n"Ăn trưa tháng 6 - 50k - tm"\n"Mua đồ ngày 15 - 200k - tk"\n\n📋 **QUẢN LÝ CÔNG VIỆC:**\n1. Lệnh thêm công việc:\n/addtask Đầu việc - Mô tả - Deadline - Trạng thái - Ghi chú\n\n2. Ví dụ đầy đủ:\n/addtask Chốt xe 16 chỗ - Đã liên hệ nhà xe - 6/6 - Đã hoàn thành - Cần xác nhận giá\n\n3. Ví dụ đơn giản:\n/addtask Chốt xe 16 chỗ - 6/6 - Đang thực hiện\n\n4. Từ khóa nhanh:\n/cv Chốt xe 16 chỗ - Đã liên hệ nhà xe - 6/6 - Đã hoàn thành - Cần xác nhận giá\n\n💳 **Phương thức thanh toán:**\n• tk/ck = Chuyển khoản\n• tm = Tiền mặt\n\n💰 **Đơn vị tiền tệ:**\n• k = nghìn (100k = 100,000)\n• tr = triệu (2tr = 2,000,000)\n\n📊 **Đơn vị số lượng:**\n• L, lít, kg, g, cái, chiếc, ly, chai, hộp, gói, túi, m, cm, km\n\n🎯 **Mức ưu tiên:**\n• Cao, Trung bình, Bình thường, Thấp\n\n⏰ **Nhắc nhở tự động:**\n• 12:00 trưa\n• 18:00 tối\n• 22:00 tối\n\n📋 **Lệnh khác:**\n/menu - Menu quản lý (có nút bấm)\n/tasks - Xem danh sách công việc\n/cv - Thêm công việc nhanh\n/addtask - Thêm công việc\n/reminder_on - Bật nhắc nhở\n/reminder_off - Tắt nhắc nhở\n/reminder_status - Kiểm tra trạng thái nhắc nhở\n/test_reminder - Test nhắc nhở ngay\n/categories - Xem danh mục\n/report - Báo cáo chi tiêu tháng\n/getid - Lấy Chat ID\n/channel_test - Test kết nối Channel\n/group_test - Test kết nối Group\n\n⏰ **Nhắc nhở công việc:**\n• 7:00, 8:00, 9:00, 13:00, 18:00`);
});

// Xử lý lệnh /categories
bot.command('categories', (ctx) => {
  let message = `📋 DANH MỤC CHI TIÊU:\n\n`;

  for (const [category, data] of Object.entries(categories)) {
    message += `${data.emoji} ${category.charAt(0).toUpperCase() + category.slice(1)}:\n`;
    message += `• ${data.subcategories.join(', ')}\n\n`;
  }

  ctx.reply(message);
});

// Xử lý lệnh bật/tắt nhắc nhở
bot.command('reminder_on', (ctx) => {
  const userId = ctx.from.id;
  reminderUsers.add(userId);
  ctx.reply('✅ Đã BẬT nhắc nhở tự động!\n\n💰 **Nhắc nhở chi tiêu:**\n• 12:00 trưa\n• 18:00 tối\n• 22:00 tối\n\n📋 **Nhắc nhở công việc:**\n• 07:00 sáng\n• 08:00 sáng\n• 09:00 sáng\n• 13:00 trưa\n• 18:00 tối\n\n💡 Gõ /reminder_status để kiểm tra trạng thái', { parse_mode: 'Markdown' });
});

bot.command('reminder_off', (ctx) => {
  const userId = ctx.from.id;
  reminderUsers.delete(userId);
  ctx.reply('❌ Đã TẮT nhắc nhở tự động!\n\n💡 Gõ /reminder_on để bật lại');
});

// Lệnh test cron ngay lập tức
bot.command('test_cron', async (ctx) => {
  try {
    const response = await fetch(`${process.env.VERCEL_URL || 'https://telegram-expense-bot.vercel.app'}/api/cron`);
    const data = await response.json();

    let message = '🧪 **TEST CRON ENDPOINT**\n\n';
    message += `✅ **Status:** ${data.success ? 'Success' : 'Failed'}\n`;
    message += `🕐 **Time:** ${data.time}\n`;
    message += `⏰ **Hour:** ${data.hour}\n`;
    message += `📋 **Actions:** ${data.actions?.length || 0}\n`;

    if (data.actions && data.actions.length > 0) {
      message += `\n**Executed:**\n`;
      data.actions.forEach(action => {
        message += `• ${action}\n`;
      });
    }

    message += `\n💬 **Message:** ${data.message}`;

    ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply(`❌ **LỖI TEST CRON**\n\nKhông thể gọi endpoint cron:\n${error.message}`);
  }
});

// Lệnh test đơn giản
bot.command('test_simple', async (ctx) => {
  const userId = ctx.from.id;
  const now = new Date();
  const vietnamTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));

  let message = '🧪 **TEST ĐỠN GIẢN**\n\n';
  message += `🕐 **Giờ hiện tại (VN):** ${vietnamTime.toLocaleString('vi-VN')}\n`;
  message += `👤 **User ID:** ${userId}\n`;
  message += `🔔 **Đã đăng ký nhắc nhở:** ${reminderUsers.has(userId) ? 'Có' : 'Không'}\n`;
  message += `👥 **Tổng users:** ${reminderUsers.size}\n\n`;

  // Test gửi nhắc nhở chi tiêu
  message += '📝 **Test nhắc nhở chi tiêu:**\n';
  message += 'Đừng quên ghi chi tiêu hôm nay!\n\n';

  // Test environment variables
  message += '🔧 **Environment Variables:**\n';
  message += `• TASK_SHEET_ID: ${TASK_SHEET_ID ? 'Có' : 'Không'}\n`;
  message += `• GOOGLE_SHEET_ID: ${process.env.GOOGLE_SHEET_ID ? 'Có' : 'Không'}\n\n`;

  message += '✅ Test hoàn thành!';

  ctx.reply(message, { parse_mode: 'Markdown' });
});

// Lệnh kiểm tra trạng thái nhắc nhở
bot.command('reminder_status', (ctx) => {
  const userId = ctx.from.id;
  const isRegistered = reminderUsers.has(userId);
  const now = new Date();
  const vietnamTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));

  let message = `📊 **TRẠNG THÁI NHẮC NHỞ**\n\n`;
  message += `👤 **User ID:** ${userId}\n`;
  message += `🔔 **Trạng thái:** ${isRegistered ? '✅ Đã bật' : '❌ Đã tắt'}\n`;
  message += `👥 **Tổng users đăng ký:** ${reminderUsers.size}\n`;
  message += `🕐 **Giờ hiện tại (VN):** ${vietnamTime.toLocaleString('vi-VN')}\n\n`;

  message += `⏰ **Lịch nhắc nhở chi tiêu:**\n`;
  message += `• 12:00 trưa\n• 18:00 tối\n• 22:00 tối\n\n`;

  message += `📋 **Lịch nhắc nhở công việc:**\n`;
  message += `• 07:00 sáng\n• 08:00 sáng\n• 09:00 sáng\n• 13:00 trưa\n• 18:00 tối\n\n`;

  message += `🧪 **Test:** Gõ /test_reminder để test ngay`;

  ctx.reply(message, { parse_mode: 'Markdown' });
});

// Lệnh kiểm tra Channel
bot.command('channel_test', async (ctx) => {
  if (!CHANNEL_ID) {
    return ctx.reply('❌ Chưa cấu hình CHANNEL_ID trong environment variables');
  }

  try {
    await bot.telegram.sendMessage(CHANNEL_ID, '🧪 **TEST CHANNEL**\n\nBot đã kết nối thành công với Channel!', {
      parse_mode: 'Markdown'
    });
    ctx.reply('✅ Đã gửi tin nhắn test lên Channel thành công!');
  } catch (error) {
    console.error('Lỗi test Channel:', error);
    ctx.reply(`❌ Lỗi khi gửi lên Channel: ${error.message}`);
  }
});

// Lệnh kiểm tra Group
bot.command('group_test', async (ctx) => {
  if (!GROUP_ID) {
    return ctx.reply('❌ Chưa cấu hình GROUP_ID trong environment variables');
  }

  try {
    await bot.telegram.sendMessage(GROUP_ID, '🧪 **TEST GROUP**\n\nBot đã kết nối thành công với Group!', {
      parse_mode: 'Markdown'
    });
    ctx.reply('✅ Đã gửi tin nhắn test lên Group thành công!');
  } catch (error) {
    console.error('Lỗi test Group:', error);
    ctx.reply(`❌ Lỗi khi gửi lên Group: ${error.message}`);
  }
});

// Lệnh thêm công việc
// Lệnh /cv (alias cho addtask)
bot.command('cv', async (ctx) => {
  const args = ctx.message.text.replace('/cv', '').trim();

  if (!args) {
    return ctx.reply('❌ Vui lòng nhập thông tin công việc!\n\n💡 **Format đầy đủ:**\n/cv Đầu việc - Mô tả chi tiết - Deadline - Trạng thái - Ghi chú\n\n💡 **Ví dụ:**\n/cv Chốt xe 16 chỗ - Đã liên hệ nhà xe, đã gửi thông tin - 6/6 - Đã hoàn thành - Cần xác nhận giá\n\n💡 **Format đơn giản:**\n/cv Chốt xe 16 chỗ - 6/6 - Đang thực hiện');
  }

  const task = parseTask(args);

  if (!task.name || task.name.trim() === '') {
    return ctx.reply('❌ Không nhận diện được tên công việc!\n\n💡 **Format đầy đủ:**\n/cv Đầu việc - Mô tả chi tiết - Deadline - Trạng thái - Ghi chú\n\n💡 **Ví dụ:**\n/cv Chốt xe 16 chỗ - Đã liên hệ nhà xe, đã gửi thông tin - 6/6 - Đã hoàn thành - Cần xác nhận giá');
  }

  // Hiển thị thông tin lưu trữ
  const taskSheetId = TASK_SHEET_ID || process.env.GOOGLE_SHEET_ID;
  const storageInfo = TASK_SHEET_ID ? 'Sheet Ninh (riêng cho công việc)' : 'Sheet chung với chi tiêu';

  let confirmMsg = `✅ THÔNG TIN CÔNG VIỆC:\n\n📋 **Đầu việc:** ${task.name}`;
  if (task.description) confirmMsg += `\n📝 **Mô tả:** ${task.description}`;
  if (task.deadline) confirmMsg += `\n⏰ **Deadline:** ${task.deadline}`;
  confirmMsg += `\n📊 **Trạng thái:** ${task.status}`;
  confirmMsg += `\n📅 **Bắt đầu:** ${task.startTime}`;
  if (task.notes) confirmMsg += `\n📝 **Ghi chú:** ${task.notes}`;
  confirmMsg += `\n💾 **Lưu vào:** ${storageInfo}`;
  confirmMsg += '\n\n⏳ Đang lưu...';

  const loadingMsg = await ctx.reply(confirmMsg);

  const saved = await saveTaskToSheet(
    ctx.from.id,
    ctx.from.username || ctx.from.first_name,
    task
  );

  if (saved) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      confirmMsg.replace('⏳ Đang lưu...', '✅ ĐÃ LƯU THÀNH CÔNG!')
    );
  } else {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      '❌ LỖI KHI LƯU CÔNG VIỆC!'
    );
  }
});

bot.command('addtask', async (ctx) => {
  const args = ctx.message.text.replace('/addtask', '').trim();

  if (!args) {
    return ctx.reply('❌ Vui lòng nhập thông tin công việc!\n\n💡 **Format đầy đủ:**\n/addtask Đầu việc - Mô tả chi tiết - Deadline - Trạng thái - Ghi chú\n\n💡 **Ví dụ:**\n/addtask Chốt xe 16 chỗ - Đã liên hệ nhà xe, đã gửi thông tin - 6/6 - Đã hoàn thành - Cần xác nhận giá\n\n💡 **Format đơn giản:**\n/addtask Chốt xe 16 chỗ - 6/6 - Đang thực hiện');
  }

  const task = parseTask(args);

  if (!task.name || task.name.trim() === '') {
    return ctx.reply('❌ Không nhận diện được tên công việc!\n\n💡 **Format đầy đủ:**\n/addtask Đầu việc - Mô tả chi tiết - Deadline - Trạng thái - Ghi chú\n\n💡 **Ví dụ:**\n/addtask Chốt xe 16 chỗ - Đã liên hệ nhà xe, đã gửi thông tin - 6/6 - Đã hoàn thành - Cần xác nhận giá');
  }

  // Hiển thị thông tin lưu trữ
  const taskSheetId = TASK_SHEET_ID || process.env.GOOGLE_SHEET_ID;
  const storageInfo = TASK_SHEET_ID ? 'Sheet Ninh (riêng cho công việc)' : 'Sheet chung với chi tiêu';

  let confirmMsg = `✅ THÔNG TIN CÔNG VIỆC:\n\n📋 **Đầu việc:** ${task.name}`;
  if (task.description) confirmMsg += `\n📝 **Mô tả:** ${task.description}`;
  if (task.deadline) confirmMsg += `\n⏰ **Deadline:** ${task.deadline}`;
  confirmMsg += `\n📊 **Trạng thái:** ${task.status}`;
  confirmMsg += `\n📅 **Bắt đầu:** ${task.startTime}`;
  if (task.notes) confirmMsg += `\n📝 **Ghi chú:** ${task.notes}`;
  confirmMsg += `\n💾 **Lưu vào:** ${storageInfo}`;
  confirmMsg += '\n\n⏳ Đang lưu...';

  const loadingMsg = await ctx.reply(confirmMsg);

  const saved = await saveTaskToSheet(
    ctx.from.id,
    ctx.from.username || ctx.from.first_name,
    task
  );

  if (saved) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      confirmMsg.replace('⏳ Đang lưu...', '✅ ĐÃ LƯU THÀNH CÔNG!')
    );
  } else {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      '❌ LỖI KHI LƯU CÔNG VIỆC!'
    );
  }
});

// Lệnh xem danh sách công việc
bot.command('tasks', async (ctx) => {
  const loadingMsg = await ctx.reply('📋 Đang tải danh sách công việc...');

  const tasks = await getTaskList();

  if (tasks.length === 0) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      '📋 **DANH SÁCH CÔNG VIỆC**\n\n🎉 Hiện tại không có công việc nào!\n\n💡 Gõ /menu để tạo công việc mới'
    );
  }

  let message = `📋 **DANH SÁCH CÔNG VIỆC** (${tasks.length} việc)\n\n`;

  tasks.forEach((task, index) => {
    const statusEmoji = task.status && task.status.toLowerCase().includes('hoàn thành') ? '✅' :
                       task.status && task.status.toLowerCase().includes('đang') ? '🔄' : '⏳';

    message += `${statusEmoji} **${task.name}**\n`;
    if (task.deadline) message += `   ⏰ ${task.deadline}\n`;
    message += `   📊 ${task.status || 'Chưa xác định'}\n`;
    if (task.progress) message += `   📈 ${task.progress}%\n`;
    if (task.notes) message += `   📝 ${task.notes}\n`;
    message += '\n';
  });

  message += `💡 Gõ /menu để tạo công việc mới`;

  ctx.telegram.editMessageText(
    ctx.chat.id,
    loadingMsg.message_id,
    null,
    message,
    { parse_mode: 'Markdown' }
  );
});

// Lệnh menu tạo công việc nhanh
bot.command('menu', async (ctx) => {
  const keyboard = {
    inline_keyboard: [
      [
        { text: '📋 Tạo công việc mới', callback_data: 'create_task' },
        { text: '📊 Xem danh sách', callback_data: 'view_tasks' }
      ],
      [
        { text: '⚡ Công việc khẩn cấp', callback_data: 'urgent_task' },
        { text: '📅 Công việc hôm nay', callback_data: 'today_task' }
      ],
      [
        { text: '🔄 Đang thực hiện', callback_data: 'status_doing' },
        { text: '✅ Hoàn thành', callback_data: 'status_done' }
      ],
      [
        { text: '💰 Ghi chi tiêu', callback_data: 'add_expense' },
        { text: '📊 Báo cáo tháng', callback_data: 'monthly_report' }
      ]
    ]
  };

  ctx.reply(
    '🎛️ **MENU QUẢN LÝ**\n\nChọn chức năng bạn muốn sử dụng:',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }
  );
});

// Xử lý callback từ inline keyboard
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  try {
    if (data === 'create_task') {
      await ctx.answerCbQuery('Tạo công việc mới');
      ctx.reply('📋 **TẠO CÔNG VIỆC MỚI**\n\nNhập theo format:\n/cv Tên công việc - Mô tả - Deadline - Trạng thái - Ghi chú\n\n💡 Ví dụ:\n/cv Họp team - Chuẩn bị agenda - 7/6 - Chưa bắt đầu - Cần book phòng', { parse_mode: 'Markdown' });

    } else if (data === 'view_tasks') {
      await ctx.answerCbQuery('Xem danh sách công việc');
      ctx.reply('/tasks');

    } else if (data === 'urgent_task') {
      await ctx.answerCbQuery('Tạo công việc khẩn cấp');
      ctx.reply('⚡ **CÔNG VIỆC KHẨN CẤP**\n\nNhập:\n/cv [Tên công việc] - [Mô tả] - Hôm nay - Khẩn cấp - [Ghi chú]', { parse_mode: 'Markdown' });

    } else if (data === 'today_task') {
      await ctx.answerCbQuery('Tạo công việc hôm nay');
      const today = new Date().toLocaleDateString('vi-VN');
      ctx.reply(`📅 **CÔNG VIỆC HÔM NAY**\n\nNhập:\n/cv [Tên công việc] - [Mô tả] - ${today} - Đang thực hiện - [Ghi chú]`, { parse_mode: 'Markdown' });

    } else if (data === 'status_doing') {
      await ctx.answerCbQuery('Cập nhật trạng thái đang thực hiện');
      ctx.reply('🔄 **CẬP NHẬT TRẠNG THÁI**\n\nNhập:\n/cv [Tên công việc] - [Mô tả] - [Deadline] - Đang thực hiện - [Ghi chú]', { parse_mode: 'Markdown' });

    } else if (data === 'status_done') {
      await ctx.answerCbQuery('Cập nhật trạng thái hoàn thành');
      ctx.reply('✅ **HOÀN THÀNH CÔNG VIỆC**\n\nNhập:\n/cv [Tên công việc] - [Mô tả] - [Deadline] - Hoàn thành - [Ghi chú]', { parse_mode: 'Markdown' });

    } else if (data === 'add_expense') {
      await ctx.answerCbQuery('Ghi chi tiêu');
      ctx.reply('💰 **GHI CHI TIÊU**\n\nNhập theo format:\n"Mô tả - Số tiền - Phương thức"\n\n💡 Ví dụ:\n"Ăn trưa - 50k - tm"\n"Đổ xăng - 500k - tk"', { parse_mode: 'Markdown' });

    } else if (data === 'monthly_report') {
      await ctx.answerCbQuery('Xem báo cáo tháng');
      ctx.reply('/report');
    }
  } catch (error) {
    console.error('Lỗi xử lý callback:', error);
    await ctx.answerCbQuery('Có lỗi xảy ra, vui lòng thử lại');
  }
});

// Lệnh lấy Chat ID
bot.command('getid', async (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const chatTitle = ctx.chat.title || ctx.chat.first_name || 'Unknown';
  const messageThreadId = ctx.message.message_thread_id;

  let message = `🆔 **THÔNG TIN CHAT**\n\n`;
  message += `📋 **Chat ID:** \`${chatId}\`\n`;
  message += `📝 **Loại:** ${chatType}\n`;
  message += `🏷️ **Tên:** ${chatTitle}\n`;

  // Hiển thị Topic ID nếu có
  if (messageThreadId) {
    message += `🏷️ **Topic ID:** \`${messageThreadId}\`\n`;
  }

  message += `\n`;

  if (chatType === 'group' || chatType === 'supergroup') {
    message += `💡 **Hướng dẫn:**\n`;
    message += `1. Copy Chat ID: \`${chatId}\`\n`;
    message += `2. Thêm vào Vercel Environment Variables:\n`;
    message += `   • Name: \`GROUP_ID\`\n`;
    message += `   • Value: \`${chatId}\`\n`;

    if (messageThreadId) {
      message += `\n🏷️ **Cấu hình Topic:**\n`;
      message += `• Nếu đây là Topic Chi tiêu:\n`;
      message += `  Name: \`EXPENSE_TOPIC_ID\`\n`;
      message += `  Value: \`${messageThreadId}\`\n`;
      message += `• Nếu đây là Topic Công việc:\n`;
      message += `  Name: \`TASK_TOPIC_ID\`\n`;
      message += `  Value: \`${messageThreadId}\`\n`;
    }

    message += `\n3. Deploy lại project\n`;
    message += `4. Gửi \`/group_test\` để kiểm tra`;
  } else if (chatType === 'channel') {
    message += `💡 **Hướng dẫn:**\n`;
    message += `1. Copy Chat ID: \`${chatId}\`\n`;
    message += `2. Thêm vào Vercel Environment Variables:\n`;
    message += `   • Name: \`CHANNEL_ID\`\n`;
    message += `   • Value: \`${chatId}\`\n`;
    message += `3. Deploy lại project\n`;
    message += `4. Gửi \`/channel_test\` để kiểm tra`;
  } else {
    message += `💡 Đây là chat riêng, không cần cấu hình ID.`;
  }

  ctx.reply(message, { parse_mode: 'Markdown' });
});

// Hàm tổng kết chi tiêu theo tháng
async function getMonthlyReport(month, year) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const targetMonth = month || new Date().getMonth() + 1;
    const targetYear = year || new Date().getFullYear();

    let totalExpense = 0;
    let totalIncome = 0;
    let cumulativeBalance = 0; // Số dư tích lũy từ đầu
    const categoryStats = {};
    const paymentMethodStats = {};
    let transactionCount = 0;

    // Tính số dư tích lũy từ đầu đến cuối tháng được chọn
    for (const row of rows) {
      const dateStr = row.get('Ngày');
      const amount = parseFloat(row.get('Số tiền')) || 0;
      const type = row.get('Loại');
      const category = row.get('Danh mục');
      const paymentMethod = row.get('Phương thức thanh toán');

      if (dateStr) {
        const [day, month_row, year_row] = dateStr.split('/').map(Number);
        const rowDate = new Date(year_row, month_row - 1, day);
        const targetDate = new Date(targetYear, targetMonth - 1, 31); // Cuối tháng target

        // Tính tất cả giao dịch từ đầu đến cuối tháng được chọn
        if (rowDate <= targetDate) {
          if (type === 'expense') {
            cumulativeBalance -= amount;
          } else if (type === 'income') {
            cumulativeBalance += amount;
          }
        }

        // Thống kê riêng cho tháng được chọn
        if (month_row === targetMonth && year_row === targetYear) {
          transactionCount++;

          if (type === 'expense') {
            totalExpense += amount;
          } else if (type === 'income') {
            totalIncome += amount;
          }

          // Thống kê theo danh mục (chỉ tính chi tiêu)
          if (category && type === 'expense') {
            categoryStats[category] = (categoryStats[category] || 0) + amount;
          }

          // Thống kê theo phương thức thanh toán (chỉ tính chi tiêu)
          if (paymentMethod && type === 'expense') {
            paymentMethodStats[paymentMethod] = (paymentMethodStats[paymentMethod] || 0) + amount;
          }
        }
      }
    }

    return {
      month: targetMonth,
      year: targetYear,
      totalExpense,
      totalIncome,
      monthlyBalance: totalIncome - totalExpense, // Số dư trong tháng
      cumulativeBalance, // Số dư tích lũy từ đầu
      categoryStats,
      paymentMethodStats,
      transactionCount
    };
  } catch (error) {
    console.error('Lỗi khi tạo báo cáo tháng:', error);
    return null;
  }
}

// Lệnh tổng kết chi tiêu tháng
bot.command('report', async (ctx) => {
  const args = ctx.message.text.split(' ');
  let month, year;

  if (args.length >= 2) {
    month = parseInt(args[1]);
    if (args.length >= 3) {
      year = parseInt(args[2]);
    }
  }

  const loadingMsg = await ctx.reply('📊 Đang tạo báo cáo chi tiêu...');

  const report = await getMonthlyReport(month, year);

  if (!report) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      null,
      '❌ Không thể tạo báo cáo! Vui lòng thử lại sau.'
    );
  }

  let message = `📊 **BÁO CÁO CHI TIÊU THÁNG ${report.month}/${report.year}**\n\n`;

  // Tổng quan
  message += `💰 **TỔNG QUAN THÁNG:**\n`;
  message += `• Chi tiêu: ${report.totalExpense.toLocaleString('vi-VN')} ₫\n`;
  message += `• Thu nhập: ${report.totalIncome.toLocaleString('vi-VN')} ₫\n`;
  message += `• Số dư tháng: ${report.monthlyBalance.toLocaleString('vi-VN')} ₫ ${report.monthlyBalance >= 0 ? '✅' : '❌'}\n`;
  message += `• Số giao dịch: ${report.transactionCount}\n\n`;

  // Số dư tích lũy
  message += `💳 **SỐ DƯ TÍCH LŨY:**\n`;
  message += `• Tổng số dư: ${report.cumulativeBalance.toLocaleString('vi-VN')} ₫ ${report.cumulativeBalance >= 0 ? '✅' : '❌'}\n`;
  message += `• (Tính từ đầu đến cuối tháng ${report.month}/${report.year})\n\n`;

  // Top 5 danh mục chi tiêu nhiều nhất
  const topCategories = Object.entries(report.categoryStats)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5);

  if (topCategories.length > 0) {
    message += `🏆 **TOP DANH MỤC CHI TIÊU:**\n`;
    topCategories.forEach(([category, amount], index) => {
      const emoji = categories[category.toLowerCase()]?.emoji || '💰';
      message += `${index + 1}. ${emoji} ${category}: ${amount.toLocaleString('vi-VN')} ₫\n`;
    });
    message += '\n';
  }

  // Thống kê phương thức thanh toán
  const paymentMethods = Object.entries(report.paymentMethodStats);
  if (paymentMethods.length > 0) {
    message += `💳 **PHƯƠNG THỨC THANH TOÁN:**\n`;
    paymentMethods.forEach(([method, amount]) => {
      const percentage = ((amount / report.totalExpense) * 100).toFixed(1);
      message += `• ${method}: ${amount.toLocaleString('vi-VN')} ₫ (${percentage}%)\n`;
    });
  }

  ctx.telegram.editMessageText(
    ctx.chat.id,
    loadingMsg.message_id,
    null,
    message,
    { parse_mode: 'Markdown' }
  );
});

// Hàm xử lý công việc
function parseTask(text) {
  // Loại bỏ prefix công việc nếu có
  let cleanText = text;

  // Kiểm tra và loại bỏ các prefix
  const prefixes = ['#cv:', '#cv', 'cv:', 'cv', '!task:', '!task', 'task:', 'task', '/cv'];
  for (const prefix of prefixes) {
    if (cleanText.toLowerCase().startsWith(prefix.toLowerCase())) {
      cleanText = cleanText.substring(prefix.length).trim();
      break;
    }
  }

  console.log('Original text:', text);
  console.log('Clean text after prefix removal:', cleanText);

  // Nếu không có nội dung sau khi loại bỏ prefix
  if (!cleanText || cleanText.trim() === '') {
    console.log('No content after prefix removal');
    return { name: '', description: '', deadline: '', status: 'Chưa bắt đầu' };
  }

  // Phân tích công việc theo format: "Đầu việc - Mô tả - Deadline - Trạng thái - Ghi chú"
  const parts = cleanText.split(' - ').map(part => part.trim());

  let taskName = parts[0] || '';
  let description = parts[1] || '';
  let deadline = parts[2] || '';
  let status = parts[3] || 'Chưa bắt đầu';
  let notes = parts[4] || '';

  // Nếu chỉ có 3 phần, coi như format cũ: "Tên - Deadline - Trạng thái"
  if (parts.length === 3) {
    taskName = parts[0] || '';
    deadline = parts[1] || '';
    status = parts[2] || 'Chưa bắt đầu';
    description = '';
    notes = '';
  }

  console.log('Parsed parts:', { taskName, description, deadline, status, notes });

  return {
    name: taskName,
    description: description,
    deadline: deadline,
    status: status,
    notes: notes,
    progress: 0,
    startTime: new Date().toLocaleDateString('vi-VN'),
    createdDate: new Date().toLocaleDateString('vi-VN'),
    createdTime: new Date().toISOString()
  };
}

// Hàm lưu công việc vào Google Sheets
async function saveTaskToSheet(userId, username, taskData) {
  try {
    // Sử dụng sheet riêng cho công việc nếu có
    const taskSheetId = TASK_SHEET_ID || process.env.GOOGLE_SHEET_ID;
    const taskDoc = new GoogleSpreadsheet(taskSheetId, serviceAccountAuth);

    await taskDoc.loadInfo();

    // Tìm sheet "Ninh" hoặc sheet đầu tiên
    let sheet = taskDoc.sheetsByTitle['Ninh'] || taskDoc.sheetsByIndex[0];

    // Lấy số STT tiếp theo
    const rows = await sheet.getRows();
    const nextSTT = rows.length + 1;

    await sheet.addRow({
      'STT': nextSTT,
      'Đầu Việc': taskData.name,
      'Mô Tả Chi Tiết': taskData.description || '',
      'Thời Gian Bắt Đầu': taskData.startTime || taskData.createdDate,
      'Thời Gian Kết Thúc (Deadline)': taskData.deadline || '',
      'Tiến Độ (%)': taskData.progress || 0,
      'Trạng Thái': taskData.status || 'Chưa bắt đầu',
      'Ghi Chú / Vướng Mắc:': taskData.notes || `Tạo bởi ${username} (${userId})`
    });

    return true;
  } catch (error) {
    console.error('Lỗi khi lưu công việc:', error);
    return false;
  }
}

// Xử lý tin nhắn trong Group với phân biệt Topic
bot.on('message', async (ctx) => {
  // Chỉ xử lý tin nhắn từ Group được cấu hình hoặc private chat
  const chatId = ctx.chat.id;
  const isConfiguredGroup = GROUP_ID && chatId.toString() === GROUP_ID;
  const isPrivateChat = ctx.chat.type === 'private';

  if (!isConfiguredGroup && !isPrivateChat) {
    return; // Bỏ qua tin nhắn từ group khác
  }

  // Chỉ xử lý tin nhắn văn bản (không phải lệnh)
  if (ctx.message.text && !ctx.message.text.startsWith('/')) {
    const text = ctx.message.text;
    const messageThreadId = ctx.message.message_thread_id;

    // Kiểm tra xem có phải topic công việc không
    const isTaskTopic = TASK_TOPIC_ID && messageThreadId && messageThreadId.toString() === TASK_TOPIC_ID;
    const isExpenseTopic = EXPENSE_TOPIC_ID && messageThreadId && messageThreadId.toString() === EXPENSE_TOPIC_ID;
    const isTaskKeyword = /^(#cv:?|!task:?|cv:?|task:?|\/cv)\s*/i.test(text);

    console.log('Message analysis:');
    console.log('- Text:', text);
    console.log('- messageThreadId:', messageThreadId);
    console.log('- TASK_TOPIC_ID:', TASK_TOPIC_ID);
    console.log('- EXPENSE_TOPIC_ID:', EXPENSE_TOPIC_ID);
    console.log('- isTaskTopic:', isTaskTopic);
    console.log('- isExpenseTopic:', isExpenseTopic);
    console.log('- isTaskKeyword:', isTaskKeyword);

    // Xử lý công việc
    if (isTaskTopic || isTaskKeyword) {
      console.log('Processing task. isTaskTopic:', isTaskTopic, 'isTaskKeyword:', isTaskKeyword);
      const task = parseTask(text);

      console.log('Task parsed:', task);

      if (!task.name || task.name.trim() === '') {
        console.log('Task name is empty:', task.name);
        return ctx.reply('❌ Không nhận diện được tên công việc!\n\n💡 Ví dụ:\n• "#cv Hoàn thành báo cáo - 15/6 - Cao"\n• "cv: Họp team - Thứ 2 - Bình thường"');
      }

      let confirmMsg = `✅ THÔNG TIN CÔNG VIỆC:\n\n📋 ${task.name}`;
      if (task.deadline) confirmMsg += `\n⏰ Deadline: ${task.deadline}`;
      confirmMsg += `\n🎯 Ưu tiên: ${task.priority}`;
      confirmMsg += `\n📅 Ngày tạo: ${task.createdDate}`;
      confirmMsg += '\n\n⏳ Đang lưu...';

      const loadingMsg = await ctx.reply(confirmMsg);

      const saved = await saveTaskToSheet(
        ctx.from.id,
        ctx.from.username || ctx.from.first_name,
        task
      );

      if (saved) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          null,
          confirmMsg.replace('⏳ Đang lưu...', '✅ ĐÃ LƯU THÀNH CÔNG!')
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          null,
          '❌ LỖI KHI LƯU CÔNG VIỆC!'
        );
      }
      return;
    }

    // Xử lý chi tiêu (logic cũ)
    if (!isTaskTopic && !isTaskKeyword) {
      const expense = parseExpense(text);

      if (expense.amount <= 0) {
        return ctx.reply('❌ Không nhận diện được số tiền!\n\n💡 Ví dụ: "Phở bò 55k tm" hoặc "Ứng 5 triệu tk"');
      }

      let confirmMsg = `✅ THÔNG TIN GIAO DỊCH:\n\n${expense.emoji} ${expense.category}\n📝 ${expense.description}\n💰 ${expense.amount.toLocaleString('vi-VN')} ₫`;

      // Hiển thị số lượng nếu khác 1
      if (expense.quantity && expense.quantity !== 1) {
        confirmMsg += `\n📊 Số lượng: ${expense.quantity}`;
      }

      confirmMsg += `\n💳 ${expense.paymentMethod}`;

      // Hiển thị ngày nếu khác ngày hiện tại
      if (expense.customDate) {
        const now = new Date();
        const targetDate = expense.customDate;
        if (targetDate.toDateString() !== now.toDateString()) {
          confirmMsg += `\n📅 ${targetDate.toLocaleDateString('vi-VN')}`;
        }
      }

      confirmMsg += '\n\n⏳ Đang lưu...';

      const loadingMsg = await ctx.reply(confirmMsg);

      const saved = await saveToSheet(
        ctx.from.id,
        ctx.from.username || ctx.from.first_name,
        expense
      );

      if (saved) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          null,
          confirmMsg.replace('⏳ Đang lưu...', '✅ ĐÃ LƯU THÀNH CÔNG!')
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          null,
          '❌ LỖI KHI LƯU DỮ LIỆU!'
        );
      }
    }
  }
});



// Xử lý ảnh có chú thích
bot.on('photo', async (ctx) => {
  const caption = ctx.message.caption;
  
  if (!caption) {
    return ctx.reply('⚠️ VUI LÒNG GỬI ẢNH KÈM CHÚ THÍCH!\n\nVí dụ: "Phở bò 55k tm"');
  }

  const expense = parseExpense(caption);
  
  if (expense.amount <= 0) {
    return ctx.reply('❌ KHÔNG NHẬN DIỆN ĐƯỢC SỐ TIỀN TRONG CHÚ THÍCH!');
  }

  // Lấy ảnh chất lượng cao nhất
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const fileId = photo.file_id;
  
  // Tải ảnh về
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const tempFilePath = `/tmp/temp_${fileId}.jpg`;
  
  try {
    const response = await axios({
      method: 'GET',
      url: fileUrl.href,
      responseType: 'stream'
    });
    
    await pipeline(response.data, fs.createWriteStream(tempFilePath));
    
    let confirmMsg = `✅ THÔNG TIN TỪ ẢNH:\n\n${expense.emoji} ${expense.category}\n📝 ${expense.description}\n💰 ${expense.amount.toLocaleString('vi-VN')} ₫`;

    // Hiển thị số lượng nếu khác 1
    if (expense.quantity && expense.quantity !== 1) {
      confirmMsg += `\n📊 Số lượng: ${expense.quantity}`;
    }

    confirmMsg += `\n💳 ${expense.paymentMethod}`;

    // Hiển thị ngày nếu khác ngày hiện tại
    if (expense.customDate) {
      const now = new Date();
      const targetDate = expense.customDate;
      if (targetDate.toDateString() !== now.toDateString()) {
        confirmMsg += `\n📅 ${targetDate.toLocaleDateString('vi-VN')}`;
      }
    }

    confirmMsg += '\n\n⏳ Đang tải ảnh lên Drive...';
    const loadingMsg = await ctx.reply(confirmMsg);
    
    // Upload ảnh lên Drive theo tháng/năm
    const imageUrl = await uploadImageToDrive(tempFilePath, `hoa_don_${Date.now()}.jpg`);
    
    if (!imageUrl) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '❌ LỖI KHI TẢI ẢNH LÊN DRIVE! Đang lưu dữ liệu...'
      );
    }
    
    // Lưu vào sheet
    const saved = await saveToSheet(
      ctx.from.id,
      ctx.from.username || ctx.from.first_name,
      expense,
      imageUrl || ''
    );
    
    if (saved) {
      let successMsg = '✅ ĐÃ LƯU THÀNH CÔNG!\n';
      if (imageUrl) successMsg += `📎 Link ảnh: ${imageUrl}`;
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        successMsg
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '❌ LỖI KHI LƯU DỮ LIỆU VÀO SHEET!'
      );
    }
  } catch (error) {
    console.error('Lỗi khi xử lý ảnh:', error);
    ctx.reply('❌ CÓ LỖI XẢY RA KHI XỬ LÝ ẢNH!');
  }
});

// Xử lý lỗi
bot.catch((err, ctx) => {
  console.error('Bot lỗi:', err);
  ctx.reply('❌ CÓ LỖI HỆ THỐNG! Vui lòng thử lại sau.');
});

// Xử lý webhook cho Vercel
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
      res.status(200).json({ status: 'success' });
    } else {
      res.status(200).json({
        message: 'Webhook endpoint is working!',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
