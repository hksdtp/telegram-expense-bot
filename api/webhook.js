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
    // Xử lý format: "mô tả - số tiền - phương thức"
    const parts = originalText.split(' - ').map(part => part.trim());

    if (parts.length >= 2) {
      description = parts[0]; // Phần đầu là mô tả

      // Tìm số tiền trong các phần còn lại
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const amountRegex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*(k|tr|nghìn|triệu|đ|đồng|d|vnd)?\b/gi;
        const amountMatch = part.match(amountRegex);

        if (amountMatch && amountMatch.length > 0) {
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
            break;
          }
        } else {
          // Nếu không phải số tiền, có thể là phương thức thanh toán
          if (part.length <= 10) { // Giới hạn độ dài để tránh nhầm lẫn
            paymentMethodFromText = part;
          }
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
    // Xác định danh mục
    let bestMatch = '';
    let matchLength = 0;
    
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

    return true;
  } catch (error) {
    console.error('Lỗi khi lưu vào sheet:', error);
    return false;
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Danh sách user ID để nhắc nhở (có thể lưu vào database sau)
const reminderUsers = new Set();

// Hàm gửi nhắc nhở
async function sendReminder() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh'
  });

  const reminderMessage = `⏰ NHẮC NHỞ GHI CHI TIÊU (${timeStr})\n\n📝 Đừng quên ghi lại các khoản chi tiêu hôm nay!\n\n💡 Gửi tin nhắn theo format:\n• "Mô tả - Số tiền - Phương thức"\n• Ví dụ: "Ăn trưa - 50k - tm"`;

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

// Hàm kiểm tra và gửi nhắc nhở theo giờ
function checkAndSendReminder() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  // Gửi nhắc nhở vào 12:00, 18:00, 22:00
  if (minute === 0 && (hour === 12 || hour === 18 || hour === 22)) {
    sendReminder();
  }
}

// Thiết lập interval để kiểm tra mỗi phút
setInterval(checkAndSendReminder, 60000);

// Xử lý lệnh /start
bot.start((ctx) => {
  const userId = ctx.from.id;
  reminderUsers.add(userId); // Tự động đăng ký nhắc nhở

  ctx.reply(`👋 Xin chào ${ctx.from.first_name}!\n\n📝 Nhập chi tiêu theo cú pháp:\n"Mô tả [số tiền] [phương thức]\n\nVí dụ: "Phở bò 55k tm" hoặc "Ứng 5 triệu tk"\n\n⏰ Bot sẽ tự động nhắc bạn ghi chi tiêu vào 12:00, 18:00 và 22:00 hàng ngày.\n\n📖 Gõ /help để xem hướng dẫn chi tiết`);
});

// Xử lý lệnh /help
bot.help((ctx) => {
  ctx.reply(`📖 HƯỚNG DẪN SỬ DỤNG:\n\n1. Format cơ bản:\n"Ăn sáng 50k tm"\n"Xăng xe 500k tk"\n\n2. Format có dấu gạch ngang:\n"Mô tả - Số tiền - Phương thức"\n"Thanh toán sân pickleball - 2tr - tk"\n\n3. Thu nhập/Hoàn tiền:\n"Lương tháng 15 triệu tk"\n"Hoàn 200k tm"\n\n4. Hỗ trợ ngày tháng:\n"Ăn trưa tháng 6 - 50k - tm"\n"Mua đồ ngày 15 - 200k - tk"\n"Cafe 10/6 - 30k - tm"\n\n5. Gửi ảnh hóa đơn kèm chú thích\n\n💳 Phương thức thanh toán:\n• tk = Chuyển khoản\n• tm = Tiền mặt\n\n💰 Đơn vị tiền tệ:\n• k = nghìn (100k = 100,000)\n• tr = triệu (2tr = 2,000,000)\n\n⏰ Nhắc nhở tự động:\n• 12:00 trưa\n• 18:00 tối\n• 22:00 tối\n\n📋 Lệnh khác:\n/reminder_on - Bật nhắc nhở\n/reminder_off - Tắt nhắc nhở\n/categories - Xem danh mục`);
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
  ctx.reply('✅ Đã BẬT nhắc nhở tự động!\n\n⏰ Bot sẽ nhắc bạn ghi chi tiêu vào:\n• 12:00 trưa\n• 18:00 tối\n• 22:00 tối');
});

bot.command('reminder_off', (ctx) => {
  const userId = ctx.from.id;
  reminderUsers.delete(userId);
  ctx.reply('❌ Đã TẮT nhắc nhở tự động!\n\n💡 Gõ /reminder_on để bật lại');
});

// Xử lý tin nhắn văn bản
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const expense = parseExpense(text);

  if (expense.amount <= 0) {
    return ctx.reply('❌ Không nhận diện được số tiền!\n\n💡 Ví dụ: "Phở bò 55k tm" hoặc "Ứng 5 triệu tk"');
  }

  let confirmMsg = `✅ THÔNG TIN GIAO DỊCH:\n\n${expense.emoji} ${expense.category}\n📝 ${expense.description}\n💰 ${expense.amount.toLocaleString('vi-VN')} ₫\n💳 ${expense.paymentMethod}`;

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
    
    let confirmMsg = `✅ THÔNG TIN TỪ ẢNH:\n\n${expense.emoji} ${expense.category}\n📝 ${expense.description}\n💰 ${expense.amount.toLocaleString('vi-VN')} ₫\n💳 ${expense.paymentMethod}`;

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
