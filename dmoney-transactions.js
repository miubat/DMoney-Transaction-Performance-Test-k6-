// DMoney transaction load test (2 minutes, 4 phases of 30s).
//   k6 run dmoney-transactions.js
// Users come from data/users.json (create them first with: k6 run seed-users.js)
import http from 'k6/http';
import { check, fail } from 'k6';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

const base_url = __ENV.BASE_URL || 'https://dmoney.roadtocareer.net';
const partnerKey = __ENV.PARTNER_KEY || 'ROADTOSDET';
const RATE = Number(__ENV.RATE || 2); // requests per second for each transaction flow

const users = JSON.parse(open('./data/users.json'));

// Expected success message for each API
const API = {
  deposit: { path: '/transaction/deposit', message: 'Deposit successful' },
  sendmoney: { path: '/transaction/sendmoney', message: 'Send money successful' },
  payment: { path: '/transaction/payment', message: 'Payment successful' },
};

// One scenario per transaction flow.
// Flows in the same phase start together and run for the whole 30s window.
function flow(exec, phase, startTime, from, to, amount) {
  return {
    executor: 'constant-arrival-rate',
    exec,
    rate: RATE,
    timeUnit: '1s',
    duration: '30s',
    startTime,
    preAllocatedVUs: 5,
    maxVUs: 20,
    gracefulStop: '5s',
    env: { FROM: from, TO: to, AMOUNT: String(amount) },
    tags: { phase, flow: `${from}->${to}` },
  };
}

export const options = {
  scenarios: {
    // 0–30s
    p1_c1_send_c2: flow('sendMoney', 'p1', '0s', 'customer1', 'customer2', 10),
    p1_c2_pay_m1: flow('payment', 'p1', '0s', 'customer2', 'merchant1', 10),

    // 30–60s
    p2_c2_send_c1: flow('sendMoney', 'p2', '30s', 'customer2', 'customer1', 10),
    p2_a1_deposit_c2: flow('deposit', 'p2', '30s', 'agent1', 'customer2', 20),
    p2_c1_pay_m1: flow('payment', 'p2', '30s', 'customer1', 'merchant1', 10),

    // 60–90s
    p3_a1_deposit_c1: flow('deposit', 'p3', '60s', 'agent1', 'customer1', 20),
    p3_a2_deposit_c2: flow('deposit', 'p3', '60s', 'agent2', 'customer2', 20),
    p3_c1_send_c2: flow('sendMoney', 'p3', '60s', 'customer1', 'customer2', 10),
    p3_c2_pay_m2: flow('payment', 'p3', '60s', 'customer2', 'merchant2', 10),

    // 90–120s
    p4_a1_pay_m1: flow('payment', 'p4', '90s', 'agent1', 'merchant1', 10),
    p4_a2_pay_m2: flow('payment', 'p4', '90s', 'agent2', 'merchant2', 10),
    p4_c1_pay_m1: flow('payment', 'p4', '90s', 'customer1', 'merchant1', 10),
    p4_c2_pay_m2: flow('payment', 'p4', '90s', 'customer2', 'merchant2', 10),
  },

  thresholds: {
    // Overall
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
    'checks{type:transaction}': ['rate>=0.99'],

    // Deposit API
    'http_req_duration{api:deposit}': ['p(95)<1000'],
    'http_req_failed{api:deposit}': ['rate<0.01'],
    'checks{api:deposit}': ['rate>=0.99'],

    // Send Money API
    'http_req_duration{api:sendmoney}': ['p(95)<1000'],
    'http_req_failed{api:sendmoney}': ['rate<0.01'],
    'checks{api:sendmoney}': ['rate>=0.99'],

    // Payment API
    'http_req_duration{api:payment}': ['p(95)<1000'],
    'http_req_failed{api:payment}': ['rate<0.01'],
    'checks{api:payment}': ['rate>=0.99'],

    // Per phase (used to spot degradation as the workload changes)
    'http_req_duration{api:sendmoney,phase:p1}': ['p(95)<1000'],
    'http_req_duration{api:sendmoney,phase:p2}': ['p(95)<1000'],
    'http_req_duration{api:sendmoney,phase:p3}': ['p(95)<1000'],
    'http_req_duration{api:payment,phase:p1}': ['p(95)<1000'],
    'http_req_duration{api:payment,phase:p2}': ['p(95)<1000'],
    'http_req_duration{api:payment,phase:p3}': ['p(95)<1000'],
    'http_req_duration{api:payment,phase:p4}': ['p(95)<1000'],
    'http_req_duration{api:deposit,phase:p2}': ['p(95)<1000'],
    'http_req_duration{api:deposit,phase:p3}': ['p(95)<1000'],
  },
};

const jsonHeaders = { 'Content-Type': 'application/json' };

// Each user logs in with their own credentials (login -> OTP verify)
function login(user) {
  const loginRes = http.post(`${base_url}/user/login`,
    JSON.stringify({ phone_number: user.phone_number, password: user.password }),
    { headers: jsonHeaders, tags: { api: 'login' } });
  check(loginRes, { 'login OTP sent': (r) => r.status === 200 });

  // Server's dev mode accepts the default OTP 0000
  const otpRes = http.post(`${base_url}/user/verify-otp?env=dev`,
    JSON.stringify({ identifier: user.phone_number, otp: '0000' }),
    { headers: jsonHeaders, tags: { api: 'login' } });
  check(otpRes, {
    'verify OTP status is 200': (r) => r.status === 200,
    'token is returned': (r) => !!r.json('token'),
  });
  return otpRes.json('token');
}

export function setup() {
  const tokens = {};
  for (const key of Object.keys(users)) {
    tokens[key] = login(users[key]);
    if (!tokens[key]) fail(`Login failed for ${key}`);
  }
  return tokens;
}

function transaction(api, tokens) {
  const from = users[__ENV.FROM];
  const to = users[__ENV.TO];
  const payload = JSON.stringify({
    from_account: from.phone_number,
    to_account: to.phone_number,
    amount: Number(__ENV.AMOUNT),
  });
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokens[__ENV.FROM]}`,
      'X-AUTH-SECRET-KEY': partnerKey,
    },
    tags: { api },
  };

  const res = http.post(`${base_url}${API[api].path}`, payload, params);

  // 208 = business failure (e.g. insufficient balance), so we need 201 exactly
  const ok = check(res, {
    [`${api}: status is 201`]: (r) => r.status === 201,
    [`${api}: transaction is successful`]: (r) => r.status >= 200 && r.status < 300 && r.status !== 208,
    [`${api}: trnxId is returned`]: (r) => /^TXN/.test(r.json('trnxId') || ''),
    [`${api}: success message is correct`]: (r) => r.json('message') === API[api].message,
  }, { type: 'transaction', api });

  if (!ok) console.warn(`${api} ${__ENV.FROM}->${__ENV.TO} failed: ${res.status} ${res.body}`);
}

export function deposit(tokens) { transaction('deposit', tokens); }
export function sendMoney(tokens) { transaction('sendmoney', tokens); }
export function payment(tokens) { transaction('payment', tokens); }

export function handleSummary(data) {
  return {
    'reports/report.html': htmlReport(data, { title: 'DMoney Transaction Load Test' }),
    'reports/summary.json': JSON.stringify(data, null, 2),
    'reports/summary.txt': textSummary(data, { indent: ' ', enableColors: false }),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
