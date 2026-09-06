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
  teachers: {},
  questions: {}, // Keyed by teacherId: { 'kru_somchai': [...] }
  sessions: {},
  scores: []
};

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

    const url = new URL(request.url);
    const path = url.pathname;
    const actionParam = url.searchParams.get('action');

    try {
      // -------------------------------------------------------------
      // GET REQUESTS
      // -------------------------------------------------------------
      if (request.method === 'GET') {
        
        // 1. ดึงข้อสอบ (GET /api/questions หรือ ?action=getQuestions)
        // แยกตามครูผู้สอน teacherId
        if (path === '/api/questions' || actionParam === 'getQuestions') {
          const teacherId = url.searchParams.get('teacherId') || 'default';
          const grade = url.searchParams.get('grade') || 'ALL';
          let qList = memoryStore.questions[teacherId] || [];

          if (env && env.QUIZ_KV) {
            const kvData = await env.QUIZ_KV.get(`questions_${teacherId}`, 'json');
            if (kvData) qList = kvData;
          }

          if (grade !== 'ALL') {
            qList = qList.filter(q => q.grade === grade);
          }

          return new Response(JSON.stringify({ success: true, teacherId: teacherId, questions: qList }), { headers: corsHeaders });
        }

        // 2. ดึงข้อมูลห้องสอบ (GET /api/session หรือ ?action=getSession)
        if (path === '/api/session' || actionParam === 'getSession') {
          const pin = url.searchParams.get('pin');
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

        // Default Root Health Check
        return new Response(JSON.stringify({
          status: 'online',
          service: 'QuizLive Math Cloudflare Worker API (Multi-Teacher Enabled)',
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
        // บันทึกแยกเฉพาะของครูท่านนั้น (teacherId)
        if (path === '/api/questions' || action === 'saveQuestions') {
          const teacherId = body.teacherId || 'default';
          const newQuestions = body.questions || [];
          
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

          memoryStore.sessions[pin] = session;

          if (env && env.QUIZ_KV) {
            await env.QUIZ_KV.put(`session_${pin}`, JSON.stringify(session), { expirationTtl: 86400 });
          }

          return new Response(JSON.stringify({ success: true, session: session }), { headers: corsHeaders });
        }

        // 3. ส่งคะแนนสอบ (POST /api/submit หรือ { action: 'submitScore' })
        if (path === '/api/submit' || action === 'submitScore') {
          const result = body.result || {};
          result.timestamp = new Date().toISOString();

          memoryStore.scores.push(result);

          if (env && env.QUIZ_KV) {
            let currentScores = await env.QUIZ_KV.get('scores', 'json') || [];
            currentScores.push(result);
            await env.QUIZ_KV.put('scores', JSON.stringify(currentScores));
          }

          return new Response(JSON.stringify({ success: true, message: 'บันทึกคะแนนสำเร็จ' }), { headers: corsHeaders });
        }

        // 4. บัญชีคุณครู (POST /api/auth หรือ { action: 'authTeacher' })
        if (path === '/api/auth' || action === 'authTeacher') {
          const mode = body.mode; // 'register' | 'login'
          const name = body.name || 'คุณครู';
          const pin = (body.pin || '').trim();
          const username = (body.username || body.id || ('teacher_' + pin)).trim().toLowerCase();

          if (!pin) {
            return new Response(JSON.stringify({ success: false, error: 'กรุณากรอกรหัส PIN' }), { headers: corsHeaders, status: 400 });
          }

          if (mode === 'register') {
            const teacherObj = { username, name, pin, createdAt: new Date().toISOString() };
            memoryStore.teachers[username] = teacherObj;

            if (env && env.QUIZ_KV) {
              await env.QUIZ_KV.put(`teacher_${username}`, JSON.stringify(teacherObj));
            }

            return new Response(JSON.stringify({ success: true, teacher: { username, name } }), { headers: corsHeaders });
          } else {
            let teacherObj = memoryStore.teachers[username];
            if (!teacherObj && env && env.QUIZ_KV) {
              teacherObj = await env.QUIZ_KV.get(`teacher_${username}`, 'json');
            }

            if (teacherObj && teacherObj.pin === pin) {
              return new Response(JSON.stringify({ success: true, teacher: { username: teacherObj.username, name: teacherObj.name } }), { headers: corsHeaders });
            } else if (!teacherObj) {
              // Auto-register first time login for convenience if PIN matches
              const newTeacher = { username, name, pin, createdAt: new Date().toISOString() };
              memoryStore.teachers[username] = newTeacher;
              if (env && env.QUIZ_KV) {
                await env.QUIZ_KV.put(`teacher_${username}`, JSON.stringify(newTeacher));
              }
              return new Response(JSON.stringify({ success: true, teacher: { username, name } }), { headers: corsHeaders });
            } else {
              return new Response(JSON.stringify({ success: false, error: 'รหัส PIN ไม่ถูกต้อง' }), { headers: corsHeaders, status: 401 });
            }
          }
        }

        // 5. AI Gemini Proxy (POST /api/ai หรือ { action: 'aiAnalyze' })
        if (path === '/api/ai' || action === 'aiAnalyze') {
          const apiKey = body.apiKey || 'AQ.Ab8RN6KkcvPXRhcrmUQGPD4OV__HpKA1Eg4dxnQj8K3U_bSaZw';
          const model = body.model || 'gemini-1.5-flash';
          const payload = body.payload;

          const googleRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const data = await googleRes.json();
          if (!googleRes.ok) {
            return new Response(JSON.stringify({ success: false, error: data.error ? data.error.message : 'Google API Error' }), { headers: corsHeaders, status: googleRes.status });
          }

          return new Response(JSON.stringify({ success: true, data: data }), { headers: corsHeaders });
        }
      }

      return new Response(JSON.stringify({ error: 'Endpoint Not Found' }), { headers: corsHeaders, status: 404 });

    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), { headers: corsHeaders, status: 500 });
    }
  }
};
