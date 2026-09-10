/**
 * ==============================================================================
 * QuizLive Math - Universal Cloudflare Worker Backend API (Multi-Teacher)
 * ==============================================================================
 * รองรับทั้ง:
 * 1. REST Endpoints: /api/questions, /api/session, /api/submit, /api/scores, /api/auth
 * 2. การแยกคลังข้อสอบตามครูผู้สอนแต่ละท่าน (Teacher Isolation by teacherId)
 * 3. Action Query & Body Fallback
 * 4. CORS 100% สำหรับหน้าบ้านบน GitHub Pages
 * ==============================================================================
 */

// Memory Cache Fallback
let memoryStore = {
  teachersList: [],
  teachers: {},
  questions: {}, // Keyed by teacherId: { 'kru_somchai': [...] }
  sessions: {},
  scores: [],
  settings: null
};

let d1Initialized = false;
async function ensureD1Tables(db) {
  if (!db || d1Initialized) return;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS teachers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pin TEXT UNIQUE NOT NULL,
        created_at TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        teacher_id TEXT NOT NULL,
        grade TEXT NOT NULL,
        question TEXT NOT NULL,
        choices TEXT NOT NULL,
        correct_index INTEGER NOT NULL,
        explanation TEXT,
        time_limit INTEGER DEFAULT 30,
        image TEXT,
        created_at TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS scores (
        id TEXT PRIMARY KEY,
        pin TEXT,
        teacher_id TEXT,
        no TEXT,
        name TEXT,
        room TEXT,
        grade TEXT,
        score INTEGER,
        total INTEGER,
        timestamp TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
        pin TEXT PRIMARY KEY,
        teacher_id TEXT,
        teacher_name TEXT,
        grade TEXT,
        questions TEXT,
        created_at TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )`)
    ]);
    d1Initialized = true;
  } catch(e) {
    console.warn('D1 table creation note:', e);
  }
}

async function getStoredTeachersList(env) {
  if (env && env.DB) {
    await ensureD1Tables(env.DB);
    const { results } = await env.DB.prepare('SELECT id, name, pin, created_at as createdAt FROM teachers ORDER BY created_at DESC').all();
    return results || [];
  }
  let teachers = memoryStore.teachersList || [];
  if (env && env.QUIZ_KV) {
    const kvTeachers = await env.QUIZ_KV.get('teachers_list', 'json');
    if (kvTeachers && Array.isArray(kvTeachers)) {
      teachers = kvTeachers;
      memoryStore.teachersList = kvTeachers;
    }
  }
  return teachers;
}

async function saveStoredTeachersList(env, teachers) {
  memoryStore.teachersList = teachers;
  if (env && env.QUIZ_KV) {
    await env.QUIZ_KV.put('teachers_list', JSON.stringify(teachers));
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8'
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (env && env.DB) {
      await ensureD1Tables(env.DB);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const actionParam = url.searchParams.get('action');

    try {
      // -------------------------------------------------------------
      // GET REQUESTS
      // -------------------------------------------------------------
      if (request.method === 'GET') {
        
        // 1. ดึงข้อสอบ (GET /api/questions หรือ ?action=getQuestions)
        // แยกตามครูผู้สอน teacherId (หรือ ALL / admin สำหรับแอดมิน)
        if (path === '/api/questions' || actionParam === 'getQuestions') {
          const teacherId = url.searchParams.get('teacherId') || 'default';
          const grade = url.searchParams.get('grade') || 'ALL';

          // D1 SQL Path
          if (env && env.DB) {
            let query = 'SELECT id, teacher_id as teacherId, grade, question, choices, correct_index as correctIndex, explanation, time_limit as timeLimit, image FROM questions';
            let where = [];
            let params = [];

            if (teacherId !== 'ALL' && teacherId !== 'admin') {
              where.push('teacher_id = ?');
              params.push(teacherId);
            }
            if (grade !== 'ALL') {
              where.push('grade = ?');
              params.push(grade);
            }
            if (where.length > 0) {
              query += ' WHERE ' + where.join(' AND ');
            }
            query += ' ORDER BY rowid ASC';

            const stmt = params.length > 0 ? env.DB.prepare(query).bind(...params) : env.DB.prepare(query);
            const { results } = await stmt.all();
            const qList = (results || []).map(r => {
              let parsedChoices = ['ก', 'ข', 'ค', 'ง'];
              try { parsedChoices = JSON.parse(r.choices); } catch(e){}
              return {
                id: r.id,
                teacherId: r.teacherId,
                grade: r.grade,
                question: r.question,
                choices: parsedChoices,
                correctIndex: r.correctIndex,
                explanation: r.explanation || '',
                timeLimit: r.timeLimit || 0,
                image: r.image || ''
              };
            });
            return new Response(JSON.stringify({ success: true, teacherId: teacherId, questions: qList }), { headers: corsHeaders });
          }

          let qList = [];
          if (teacherId === 'ALL' || teacherId === 'admin') {
            // ดึงข้อสอบของทุกคุณครูในระบบ
            const teachers = await getStoredTeachersList(env);
            const teacherIds = new Set(['admin', 'default', ...teachers.map(t => t.id)]);
            const allQMap = new Map();

            for (const tId of teacherIds) {
              let tQ = memoryStore.questions[tId];
              if (env && env.QUIZ_KV) {
                const kvData = await env.QUIZ_KV.get(`questions_${tId}`, 'json');
                if (kvData && Array.isArray(kvData)) tQ = kvData;
              }
              if (Array.isArray(tQ)) {
                tQ.forEach(q => {
                  if (q && q.id) allQMap.set(q.id, q);
                });
              }
            }
            qList = Array.from(allQMap.values());
          } else {
            qList = memoryStore.questions[teacherId] || [];
            if (env && env.QUIZ_KV) {
              const kvData = await env.QUIZ_KV.get(`questions_${teacherId}`, 'json');
              if (kvData && Array.isArray(kvData)) qList = kvData;
            }
          }

          if (grade !== 'ALL') {
            qList = qList.filter(q => q.grade === grade);
          }

          return new Response(JSON.stringify({ success: true, teacherId: teacherId, questions: qList }), { headers: corsHeaders });
        }

        // 2. ดึงข้อมูลห้องสอบ (GET /api/session หรือ ?action=getSession)
        if (path === '/api/session' || actionParam === 'getSession') {
          const pin = url.searchParams.get('pin');

          if (env && env.DB) {
            const row = await env.DB.prepare('SELECT pin, teacher_id as teacherId, teacher_name as teacherName, grade, questions, created_at as createdAt FROM sessions WHERE pin = ?').bind(pin).first();
            if (row) {
              let parsedQ = [];
              try { parsedQ = JSON.parse(row.questions); } catch(e){}
              return new Response(JSON.stringify({ success: true, session: { ...row, questions: parsedQ } }), { headers: corsHeaders });
            } else {
              return new Response(JSON.stringify({ success: false, error: 'ไม่พบห้องสอบนี้ หรือห้องสอบหมดอายุแล้ว' }), { headers: corsHeaders, status: 404 });
            }
          }

          let session = memoryStore.sessions[pin];
          if (!session && env && env.QUIZ_KV) {
            session = await env.QUIZ_KV.get(`session_${pin}`, 'json');
          }

          if (session) {
            return new Response(JSON.stringify({ success: true, session: session }), { headers: corsHeaders });
          } else {
            return new Response(JSON.stringify({ success: false, error: 'ไม่พบห้องสอบนี้ หรือห้องสอบหมดอายุแล้ว' }), { headers: corsHeaders, status: 404 });
          }
        }

        // 3. ดึงคะแนน (GET /api/scores หรือ ?action=getScores)
        if (path === '/api/scores' || actionParam === 'getScores') {
          const pin = url.searchParams.get('pin');
          const teacherId = url.searchParams.get('teacherId');

          if (env && env.DB) {
            let query = 'SELECT id, pin, teacher_id as teacherId, no, name, room, grade, score, total, timestamp FROM scores';
            let where = [];
            let params = [];

            if (pin && pin !== 'ALL') {
              where.push('pin = ?');
              params.push(String(pin));
            }
            if (teacherId && teacherId !== 'admin') {
              where.push('teacher_id = ?');
              params.push(teacherId);
            }
            if (where.length > 0) {
              query += ' WHERE ' + where.join(' AND ');
            }
            query += ' ORDER BY score DESC, CAST(no AS INTEGER) ASC';

            const stmt = params.length > 0 ? env.DB.prepare(query).bind(...params) : env.DB.prepare(query);
            const { results } = await stmt.all();
            return new Response(JSON.stringify({ success: true, scores: results || [] }), { headers: corsHeaders });
          }

          let scores = memoryStore.scores;
          if (env && env.QUIZ_KV) {
            const kvScores = await env.QUIZ_KV.get('scores', 'json');
            if (kvScores) scores = kvScores;
          }

          if (pin && pin !== 'ALL') {
            scores = scores.filter(s => String(s.pin) === String(pin));
          }

          if (teacherId) {
            scores = scores.filter(s => s.teacherId === teacherId);
          }

          scores.sort((a, b) => (b.score || 0) - (a.score || 0));
          return new Response(JSON.stringify({ success: true, scores: scores }), { headers: corsHeaders });
        }

        // 4. ดึงการตั้งค่าระบบและโมเดล AI (GET /api/settings หรือ ?action=getSettings)
        if (path === '/api/settings' || actionParam === 'getSettings') {
          let settings = {
            aiModel: 'gemini-2.5-flash',
            aiFallbackModel: 'gemini-1.5-flash',
            apiKey: 'AQ.Ab8RN6KkcvPXRhcrmUQGPD4OV__HpKA1Eg4dxnQj8K3U_bSaZw'
          };

          if (env && env.DB) {
            const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('system_settings').first();
            if (row && row.value) {
              try { settings = { ...settings, ...JSON.parse(row.value) }; } catch(e){}
            }
            return new Response(JSON.stringify({ success: true, settings: settings }), { headers: corsHeaders });
          }

          if (env && env.QUIZ_KV) {
            const kvSettings = await env.QUIZ_KV.get('system_settings', 'json');
            if (kvSettings) settings = { ...settings, ...kvSettings };
          } else if (memoryStore.settings) {
            settings = { ...settings, ...memoryStore.settings };
          }

          return new Response(JSON.stringify({ success: true, settings: settings }), { headers: corsHeaders });
        }

        // 5. ดึงรายชื่อครูทั้งหมดในระบบ (GET /api/teachers หรือ ?action=getTeachers)
        if (path === '/api/teachers' || actionParam === 'getTeachers') {
          const teachers = await getStoredTeachersList(env);
          return new Response(JSON.stringify({ success: true, teachers: teachers }), { headers: corsHeaders });
        }

        // Default Root Health Check
        const dbStatus = env && env.DB ? 'Connected (Cloudflare D1 SQL)' : (env && env.QUIZ_KV ? 'Connected (Cloudflare KV)' : 'Memory Cache');
        return new Response(JSON.stringify({
          status: 'online',
          database: dbStatus,
          service: 'QuizLive Math Cloudflare Worker API (D1 & KV Universal Backend)',
          time: new Date().toISOString()
        }), { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // POST REQUESTS
      // -------------------------------------------------------------
      if (request.method === 'POST') {
        let body = {};
        try {
          body = await request.json();
        } catch (e) {
          body = {};
        }

        const action = body.action;

        // 1. บันทึกข้อสอบ (POST /api/questions หรือ { action: 'saveQuestions' })
        if (path === '/api/questions' || action === 'saveQuestions') {
          const teacherId = body.teacherId || 'default';
          const newQuestions = body.questions || [];

          // D1 SQL Path
          if (env && env.DB) {
            if (teacherId === 'admin' || teacherId === 'ALL') {
              await env.DB.prepare('DELETE FROM questions').run();
            } else {
              await env.DB.prepare('DELETE FROM questions WHERE teacher_id = ?').bind(teacherId).run();
            }

            if (newQuestions.length > 0) {
              const statements = newQuestions.map(q => {
                const qTeacher = q.teacherId || teacherId;
                return env.DB.prepare(`INSERT INTO questions (id, teacher_id, grade, question, choices, correct_index, explanation, time_limit, image, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                  .bind(
                    q.id || ('q_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)),
                    qTeacher,
                    q.grade || 'ทั่วไป',
                    q.question || '',
                    JSON.stringify(q.choices || ['ก', 'ข', 'ค', 'ง']),
                    typeof q.correctIndex === 'number' ? q.correctIndex : 0,
                    q.explanation || '',
                    q.timeLimit || 0,
                    q.image || '',
                    new Date().toISOString()
                  );
              });

              for (let i = 0; i < statements.length; i += 50) {
                const chunk = statements.slice(i, i + 50);
                await env.DB.batch(chunk);
              }
            }

            return new Response(JSON.stringify({ success: true, teacherId: teacherId, count: newQuestions.length }), { headers: corsHeaders });
          }

          // KV / Memory Fallback Path
          memoryStore.questions[teacherId] = newQuestions;
          if (env && env.QUIZ_KV) {
            await env.QUIZ_KV.put(`questions_${teacherId}`, JSON.stringify(newQuestions));
          }

          return new Response(JSON.stringify({ success: true, teacherId: teacherId, count: newQuestions.length }), { headers: corsHeaders });
        }

        // 2. เปิดห้องสอบสด (POST /api/session หรือ { action: 'createSession' })
        if (path === '/api/session' || action === 'createSession') {
          const session = body.session || {};
          const pin = String(session.pin);

          if (env && env.DB) {
            await env.DB.prepare(`INSERT OR REPLACE INTO sessions (pin, teacher_id, teacher_name, grade, questions, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
              .bind(
                pin,
                session.teacherId || '',
                session.teacherName || '',
                session.grade || '',
                JSON.stringify(session.questions || []),
                session.createdAt || new Date().toISOString()
              ).run();

            return new Response(JSON.stringify({ success: true, session: session }), { headers: corsHeaders });
          }

          memoryStore.sessions[pin] = session;
          if (env && env.QUIZ_KV) {
            await env.QUIZ_KV.put(`session_${pin}`, JSON.stringify(session), { expirationTtl: 86400 });
          }

          return new Response(JSON.stringify({ success: true, session: session }), { headers: corsHeaders });
        }

        // 3. ส่งคะแนนสอบ (POST /api/submit หรือ { action: 'submitScore' })
        if (path === '/api/submit' || action === 'submitScore') {
          const result = body.result || {};
          const timestamp = result.timestamp || new Date().toISOString();
          const scoreId = 'sc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

          if (env && env.DB) {
            await env.DB.prepare(`INSERT INTO scores (id, pin, teacher_id, no, name, room, grade, score, total, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .bind(
                scoreId,
                String(result.pin || ''),
                result.teacherId || '',
                String(result.no || ''),
                result.name || '',
                String(result.room || ''),
                result.grade || '',
                Number(result.score) || 0,
                Number(result.total) || 0,
                timestamp
              ).run();

            return new Response(JSON.stringify({ success: true, message: 'บันทึกคะแนนลง D1 สำเร็จ' }), { headers: corsHeaders });
          }

          result.timestamp = timestamp;
          memoryStore.scores.push(result);
          if (env && env.QUIZ_KV) {
            let currentScores = await env.QUIZ_KV.get('scores', 'json') || [];
            currentScores.push(result);
            await env.QUIZ_KV.put('scores', JSON.stringify(currentScores));
          }

          return new Response(JSON.stringify({ success: true, message: 'บันทึกคะแนนสำเร็จ' }), { headers: corsHeaders });
        }

        // 3.1 ล้างคะแนนสอบ (POST /api/scores/clear หรือ { action: 'clearScores' })
        if (path === '/api/scores/clear' || action === 'clearScores') {
          const teacherId = body.teacherId;
          const grade = body.grade;

          if (env && env.DB) {
            let query = 'DELETE FROM scores';
            let where = [];
            let params = [];

            if (teacherId && teacherId !== 'admin') {
              where.push('teacher_id = ?');
              params.push(teacherId);
            }
            if (grade && grade !== 'ALL') {
              where.push('grade = ?');
              params.push(grade);
            }
            if (where.length > 0) {
              query += ' WHERE ' + where.join(' AND ');
            }

            const stmt = params.length > 0 ? env.DB.prepare(query).bind(...params) : env.DB.prepare(query);
            await stmt.run();
            return new Response(JSON.stringify({ success: true, message: 'ล้างคะแนนใน D1 สำเร็จ' }), { headers: corsHeaders });
          }

          let currentScores = memoryStore.scores;
          if (env && env.QUIZ_KV) {
            const kvScores = await env.QUIZ_KV.get('scores', 'json');
            if (kvScores) currentScores = kvScores;
          }

          currentScores = currentScores.filter(s => {
            if (teacherId && teacherId !== 'admin' && s.teacherId && s.teacherId !== teacherId) {
              return true;
            }
            if (grade && grade !== 'ALL' && s.grade !== grade) {
              return true;
            }
            return false;
          });

          memoryStore.scores = currentScores;
          if (env && env.QUIZ_KV) {
            await env.QUIZ_KV.put('scores', JSON.stringify(currentScores));
          }

          return new Response(JSON.stringify({ success: true, message: 'ล้างคะแนนสำเร็จ' }), { headers: corsHeaders });
        }

        // 4. บัญชีคุณครู (POST /api/auth หรือ POST /api/teachers หรือ { action: 'authTeacher' })
        if (path === '/api/auth' || path === '/api/teachers' || action === 'authTeacher') {
          const mode = body.mode || action; // 'register' | 'login' | 'deleteTeacher'
          const pin = (body.pin || '').trim();

          // โหมดลบบัญชีครู (Admin Delete Teacher)
          if (mode === 'deleteTeacher' || action === 'deleteTeacher') {
            const deleteId = body.teacherId || body.id;

            if (env && env.DB) {
              await env.DB.prepare('DELETE FROM teachers WHERE id = ?').bind(deleteId).run();
              await env.DB.prepare('DELETE FROM questions WHERE teacher_id = ?').bind(deleteId).run();
              return new Response(JSON.stringify({ success: true, message: 'ลบบัญชีครูสำเร็จ' }), { headers: corsHeaders });
            }

            let teachers = await getStoredTeachersList(env);
            teachers = teachers.filter(t => t.id !== deleteId);
            await saveStoredTeachersList(env, teachers);
            if (env && env.QUIZ_KV) {
              await env.QUIZ_KV.delete(`teacher_${deleteId}`);
            }
            return new Response(JSON.stringify({ success: true, message: 'ลบบัญชีครูสำเร็จ' }), { headers: corsHeaders });
          }

          // โหมดลงทะเบียนครูใหม่ (Register)
          if (mode === 'register') {
            const name = (body.name || 'คุณครู').trim();
            if (!pin) {
              return new Response(JSON.stringify({ success: false, error: 'กรุณากรอกรหัส PIN' }), { headers: corsHeaders, status: 400 });
            }
            if (pin === '0000') {
              return new Response(JSON.stringify({ success: false, error: 'รหัส PIN 0000 สงวนไว้สำหรับผู้ดูแลระบบ' }), { headers: corsHeaders, status: 400 });
            }

            if (env && env.DB) {
              const existing = await env.DB.prepare('SELECT id, name FROM teachers WHERE pin = ?').bind(pin).first();
              if (existing) {
                return new Response(JSON.stringify({ success: false, error: `รหัส PIN ${pin} มีผู้ใช้งานแล้ว (${existing.name})` }), { headers: corsHeaders, status: 400 });
              }
              const teacherId = body.id || ('teacher_' + Date.now());
              const now = new Date().toISOString();
              await env.DB.prepare('INSERT INTO teachers (id, name, pin, created_at) VALUES (?, ?, ?, ?)').bind(teacherId, name, pin, now).run();
              return new Response(JSON.stringify({ success: true, teacher: { id: teacherId, name, pin, createdAt: now } }), { headers: corsHeaders });
            }

            let teachers = await getStoredTeachersList(env);
            const existing = teachers.find(t => t.pin === pin);
            if (existing) {
              return new Response(JSON.stringify({ success: false, error: `รหัส PIN ${pin} มีผู้ใช้งานแล้ว (${existing.name})` }), { headers: corsHeaders, status: 400 });
            }

            const teacherId = body.id || ('teacher_' + Date.now());
            const teacherObj = { id: teacherId, name, pin, createdAt: new Date().toISOString() };
            teachers.push(teacherObj);
            await saveStoredTeachersList(env, teachers);

            if (env && env.QUIZ_KV) {
              await env.QUIZ_KV.put(`teacher_${teacherId}`, JSON.stringify(teacherObj));
            }

            return new Response(JSON.stringify({ success: true, teacher: teacherObj }), { headers: corsHeaders });
          }

          // โหมดเข้าสู่ระบบ (Login by PIN)
          if (mode === 'login') {
            if (!pin) {
              return new Response(JSON.stringify({ success: false, error: 'กรุณากรอกรหัส PIN' }), { headers: corsHeaders, status: 400 });
            }

            if (pin === '0000') {
              return new Response(JSON.stringify({
                success: true,
                teacher: { id: 'admin', name: 'แอดมิน / ผู้ดูแลระบบ', pin: '0000' }
              }), { headers: corsHeaders });
            }

            if (env && env.DB) {
              const teacher = await env.DB.prepare('SELECT id, name, pin, created_at as createdAt FROM teachers WHERE pin = ?').bind(pin).first();
              if (teacher) {
                return new Response(JSON.stringify({ success: true, teacher }), { headers: corsHeaders });
              } else {
                return new Response(JSON.stringify({ success: false, error: 'รหัส PIN ไม่ถูกต้อง หรือยังไม่ได้ลงทะเบียนในระบบ' }), { headers: corsHeaders, status: 401 });
              }
            }

            const teachers = await getStoredTeachersList(env);
            const found = teachers.find(t => t.pin === pin);
            if (found) {
              return new Response(JSON.stringify({ success: true, teacher: found }), { headers: corsHeaders });
            } else {
              return new Response(JSON.stringify({ success: false, error: 'รหัส PIN ไม่ถูกต้อง หรือยังไม่ได้ลงทะเบียนในระบบ' }), { headers: corsHeaders, status: 401 });
            }
          }

          return new Response(JSON.stringify({ success: false, error: 'ไม่พบคำสั่งที่ต้องการ' }), { headers: corsHeaders, status: 400 });
        }

        // 5. บันทึกการตั้งค่าระบบและโมเดล AI (POST /api/settings หรือ { action: 'saveSettings' })
        if (path === '/api/settings' || action === 'saveSettings') {
          let newSettings = body.settings || {};
          let currentSettings = {
            aiModel: 'gemini-2.5-flash',
            aiFallbackModel: 'gemini-1.5-flash',
            apiKey: 'AQ.Ab8RN6KkcvPXRhcrmUQGPD4OV__HpKA1Eg4dxnQj8K3U_bSaZw'
          };

          if (env && env.DB) {
            const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('system_settings').first();
            if (row && row.value) {
              try { currentSettings = { ...currentSettings, ...JSON.parse(row.value) }; } catch(e){}
            }
            const merged = { ...currentSettings, ...newSettings };
            await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('system_settings', JSON.stringify(merged)).run();
            return new Response(JSON.stringify({ success: true, settings: merged, message: 'บันทึกการตั้งค่าโมเดล AI ลง D1 เรียบร้อยแล้ว' }), { headers: corsHeaders });
          }

          if (env && env.QUIZ_KV) {
            const kvSettings = await env.QUIZ_KV.get('system_settings', 'json');
            if (kvSettings) currentSettings = { ...currentSettings, ...kvSettings };
          } else if (memoryStore.settings) {
            currentSettings = { ...currentSettings, ...memoryStore.settings };
          }

          const merged = { ...currentSettings, ...newSettings };
          memoryStore.settings = merged;

          if (env && env.QUIZ_KV) {
            await env.QUIZ_KV.put('system_settings', JSON.stringify(merged));
          }

          return new Response(JSON.stringify({ success: true, settings: merged, message: 'บันทึกการตั้งค่าโมเดล AI ลง Cloudflare KV เรียบร้อยแล้ว' }), { headers: corsHeaders });
        }

        // 6. AI Gemini Proxy (POST /api/ai หรือ { action: 'aiAnalyze' })
        if (path === '/api/ai' || action === 'aiAnalyze') {
          let sysSettings = {
            aiModel: 'gemini-2.5-flash',
            aiFallbackModel: 'gemini-1.5-flash',
            apiKey: '' // อ่านจาก D1/KV เท่านั้น — ตั้งค่าผ่านหน้า Admin
          };
          if (env && env.DB) {
            const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('system_settings').first();
            if (row && row.value) {
              try { sysSettings = { ...sysSettings, ...JSON.parse(row.value) }; } catch(e){}
            }
          } else if (env && env.QUIZ_KV) {
            const kvSettings = await env.QUIZ_KV.get('system_settings', 'json');
            if (kvSettings) sysSettings = { ...sysSettings, ...kvSettings };
          } else if (memoryStore.settings) {
            sysSettings = { ...sysSettings, ...memoryStore.settings };
          }

          const rawApiKey = (body.apiKey || sysSettings.apiKey || '').trim();
          const apiKey = rawApiKey.replace(/[^\x21-\x7E]/g, '').trim();
          const rawModel = (body.model || sysSettings.aiModel || 'gemini-2.5-flash').trim();
          const model = rawModel.replace(/[^\x21-\x7E]/g, '').trim();
          const payload = body.payload;

          // ต้องมี API Key
          if (!apiKey || apiKey.length < 15) {
            return new Response(JSON.stringify({
              success: false,
              error: 'ยังไม่มี Gemini API Key — กรุณาไปที่หน้า Admin > ตั้งค่า AI แล้วใส่ API Key จาก https://aistudio.google.com/app/apikey'
            }), { headers: corsHeaders, status: 400 });
          }

          // AQ. และ ya29. ใช้ Authorization: Bearer header, AIzaSy... ใช้ ?key=
          const isOAuth = apiKey.startsWith('ya29.') || apiKey.startsWith('AQ.');

          async function callGoogleApi(targetModel) {
            let googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent`;
            const reqHeaders = { 'Content-Type': 'application/json' };
            if (isOAuth) {
              reqHeaders['Authorization'] = `Bearer ${apiKey}`;
            } else {
              googleUrl += `?key=${encodeURIComponent(apiKey)}`;
            }

            return await fetch(googleUrl, {
              method: 'POST',
              headers: reqHeaders,
              body: JSON.stringify(payload)
            });
          }

          let googleRes = await callGoogleApi(model);
          let data = await googleRes.json().catch(() => ({}));

          // Fallback if primary model fails (e.g. 404 Not Found or deprecated)
          if (!googleRes.ok && sysSettings.aiFallbackModel && sysSettings.aiFallbackModel !== model) {
            try {
              const fbRes = await callGoogleApi(sysSettings.aiFallbackModel);
              if (fbRes.ok) {
                const fbData = await fbRes.json();
                return new Response(JSON.stringify({ success: true, data: fbData, usedModel: sysSettings.aiFallbackModel }), { headers: corsHeaders });
              }
            } catch(e){}
          }

          if (!googleRes.ok) {
            return new Response(JSON.stringify({
              success: false,
              error: data.error ? data.error.message : `Google API Error (${googleRes.status})`
            }), { headers: corsHeaders, status: googleRes.status });
          }

          return new Response(JSON.stringify({ success: true, data: data, usedModel: model }), { headers: corsHeaders });
        }
      }

      return new Response(JSON.stringify({ error: 'Endpoint Not Found' }), { headers: corsHeaders, status: 404 });

    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), { headers: corsHeaders, status: 500 });
    }
  }
};
