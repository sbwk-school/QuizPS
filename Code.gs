/**
 * ==============================================================================
 * QuizLive Math - Cloud Backend (Google Apps Script)
 * ==============================================================================
 * ทำหน้าที่เป็น Database หลังบ้าน รองรับ:
 * 1. ดึงและบันทึกคลังข้อสอบคณิตศาสตร์ (พร้อมสูตร KaTeX & รูปภาพ)
 * 2. บันทึกและดึงข้อมูลห้องสอบสด (Live Exam Session)
 * 3. บันทึกคะแนนนักเรียนลงชีต "Wคะแนน" แบบเรียลไทม์
 * ==============================================================================
 */

function doGet(e) {
  var action = e.parameter.action;
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. ดึงข้อสอบทั้งหมด
  if (action === 'getQuestions') {
    return handleGetQuestions(ss, e.parameter.grade);
  }

  // 2. ดึงข้อมูลห้องสอบ
  if (action === 'getSession') {
    return handleGetSession(ss, e.parameter.pin);
  }

  // 3. ดึงตารางคะแนน Leaderboard
  if (action === 'getScores') {
    return handleGetScores(ss, e.parameter.pin);
  }

  // ค่าเริ่มต้น แสดงสถานะพร้อมทำงาน
  return ContentService.createTextOutput(JSON.stringify({
    status: 'online',
    message: 'QuizLive Math Cloud API is Ready!'
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var postData = {};
  
  try {
    postData = JSON.parse(e.postData.contents);
  } catch (err) {
    return createJsonResponse({ success: false, error: 'Invalid JSON format' });
  }

  var action = postData.action;

  // 1. บันทึกข้อสอบชุดใหม่ลงชีต
  if (action === 'saveQuestions') {
    return handleSaveQuestions(ss, postData.questions);
  }

  // 2. เปิดห้องสอบสด (Create / Update Live Session)
  if (action === 'createSession') {
    return handleCreateSession(ss, postData.session);
  }

  // 3. บันทึกคะแนนนักเรียนส่งสอบ
  if (action === 'submitScore') {
    return handleSubmitScore(ss, postData.result);
  }

  return createJsonResponse({ success: false, error: 'Unknown action' });
}

/**
 * -----------------------------------------------------------
 * HANDLER: ดึงข้อสอบจากชีต "ข้อสอบ"
 * -----------------------------------------------------------
 */
function handleGetQuestions(ss, gradeFilter) {
  var sheet = getOrCreateSheet(ss, 'ข้อสอบ', [
    'ID', 'ระดับชั้น', 'โจทย์คำถาม', 'รูปภาพ', 'ตัวเลือก ก', 'ตัวเลือก ข', 'ตัวเลือก ค', 'ตัวเลือก ง', 'เฉลย(0-3)', 'คำอธิบายเฉลย', 'เวลาทำ(วิ)'
  ]);

  var data = sheet.getDataRange().getValues();
  var questions = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var qId = String(row[0] || ('q_' + i));
    var grade = String(row[1] || 'ม.1').trim();
    var qText = String(row[2] || '').trim();
    if (!qText) continue;

    if (gradeFilter && gradeFilter !== 'ALL' && grade !== gradeFilter) {
      continue;
    }

    questions.push({
      id: qId,
      grade: grade,
      question: qText,
      image: String(row[3] || ''),
      choices: [
        String(row[4] || ''),
        String(row[5] || ''),
        String(row[6] || ''),
        String(row[7] || '')
      ],
      correctIndex: Number(row[8]) || 0,
      explanation: String(row[9] || ''),
      timeLimit: Number(row[10]) || 30
    });
  }

  return createJsonResponse({ success: true, questions: questions });
}

/**
 * -----------------------------------------------------------
 * HANDLER: บันทึกข้อสอบลงชีต "ข้อสอบ"
 * -----------------------------------------------------------
 */
function handleSaveQuestions(ss, questionsList) {
  var sheet = getOrCreateSheet(ss, 'ข้อสอบ', [
    'ID', 'ระดับชั้น', 'โจทย์คำถาม', 'รูปภาพ', 'ตัวเลือก ก', 'ตัวเลือก ข', 'ตัวเลือก ค', 'ตัวเลือก ง', 'เฉลย(0-3)', 'คำอธิบายเฉลย', 'เวลาทำ(วิ)'
  ]);

  // เคลียร์ข้อมูลเดิมแถวที่ 2 เป็นต้นไป
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 11).clearContent();
  }

  if (!questionsList || questionsList.length === 0) {
    return createJsonResponse({ success: true, count: 0 });
  }

  var rows = [];
  for (var i = 0; i < questionsList.length; i++) {
    var q = questionsList[i];
    rows.push([
      q.id || ('q_' + (i + 1)),
      q.grade || 'ม.1',
      q.question || '',
      q.image || '',
      (q.choices && q.choices[0]) || '',
      (q.choices && q.choices[1]) || '',
      (q.choices && q.choices[2]) || '',
      (q.choices && q.choices[3]) || '',
      q.correctIndex || 0,
      q.explanation || '',
      q.timeLimit || 30
    ]);
  }

  sheet.getRange(2, 1, rows.length, 11).setValues(rows);
  return createJsonResponse({ success: true, count: rows.length });
}

/**
 * -----------------------------------------------------------
 * HANDLER: บันทึกห้องสอบลงชีต "ห้องสอบ"
 * -----------------------------------------------------------
 */
function handleCreateSession(ss, sessionData) {
  var sheet = getOrCreateSheet(ss, 'ห้องสอบ', [
    'PIN', 'ระดับชั้น', 'เวลาที่เปิด', 'สถานะ'
  ]);

  var pin = String(sessionData.pin);
  var grade = String(sessionData.grade || 'ม.1');
  var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");

  sheet.appendRow([pin, grade, now, 'ACTIVE']);
  return createJsonResponse({ success: true, pin: pin, grade: grade });
}

/**
 * -----------------------------------------------------------
 * HANDLER: ดึงข้อมูลห้องสอบ
 * -----------------------------------------------------------
 */
function handleGetSession(ss, pin) {
  var sheet = getOrCreateSheet(ss, 'ห้องสอบ', ['PIN', 'ระดับชั้น', 'เวลาที่เปิด', 'สถานะ']);
  var data = sheet.getDataRange().getValues();

  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(pin)) {
      return createJsonResponse({
        success: true,
        session: {
          pin: data[i][0],
          grade: data[i][1],
          createdAt: data[i][2],
          status: data[i][3]
        }
      });
    }
  }

  return createJsonResponse({ success: false, error: 'Session not found' });
}

/**
 * -----------------------------------------------------------
 * HANDLER: บันทึกคะแนนนักเรียนลงชีต "Wคะแนน"
 * -----------------------------------------------------------
 */
function handleSubmitScore(ss, result) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);

  var sheet = getOrCreateSheet(ss, 'Wคะแนน', [
    'วันที่เวลา', 'รหัสห้องสอบ', 'ระดับชั้น', 'ห้องเรียน', 'เลขที่', 'ชื่อผู้สอบ', 'คะแนนที่ได้', 'ข้อทั้งหมด', 'ความแม่นยำ (%)'
  ]);

  var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
  var pin = String(result.pin || '-');
  var grade = String(result.grade || '-');
  var room = String(result.room || '-');
  var studentNo = String(result.no || '-');
  var name = String(result.name || 'นักเรียน');
  var score = Number(result.score) || 0;
  var total = Number(result.total) || 0;
  var accuracy = total > 0 ? Math.round((score / total) * 100) + '%' : '0%';

  sheet.appendRow([
    now, pin, grade, room, studentNo, name, score, total, accuracy
  ]);

  lock.releaseLock();
  return createJsonResponse({ success: true, message: 'บันทึกคะแนนสำเร็จ' });
}

/**
 * -----------------------------------------------------------
 * HANDLER: ดึงคะแนน Leaderboard
 * -----------------------------------------------------------
 */
function handleGetScores(ss, pin) {
  var sheet = ss.getSheetByName('Wคะแนน');
  if (!sheet) return createJsonResponse({ success: true, scores: [] });

  var data = sheet.getDataRange().getValues();
  var scores = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (pin && pin !== 'ALL' && String(row[1]) !== String(pin)) continue;

    scores.push({
      timestamp: row[0],
      pin: row[1],
      grade: row[2],
      room: row[3],
      no: row[4],
      name: row[5],
      score: row[6],
      total: row[7],
      accuracy: row[8]
    });
  }

  // เรียงลำดับคะแนนสูงสุด
  scores.sort(function(a, b) { return b.score - a.score; });
  return createJsonResponse({ success: true, scores: scores.slice(0, 30) });
}

/**
 * HELPER: ค้นหาหรือสร้างชีต
 */
function getOrCreateSheet(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(headers);
    var range = sheet.getRange(1, 1, 1, headers.length);
    range.setBackground('#4F46E5');
    range.setFontColor('#FFFFFF');
    range.setFontWeight('bold');
    range.setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
