// Creates the 6 test users (2 Agents, 2 Customers, 2 Merchants), activates them
// and gives them starting balance. Run once before the load test:
//   k6 run seed-users.js
// The created users are saved to data/users.json.
import http from 'k6/http';
import { check, fail } from 'k6';

const base_url = __ENV.BASE_URL || 'https://dmoney.roadtocareer.net';
const partnerKey = __ENV.PARTNER_KEY || 'ROADTOSDET';
const gmailBase = __ENV.GMAIL_BASE || 'k6.dmoney.loadtest'; // remote server only accepts @gmail.com
const password = '1234';

export const options = {
  vus: 1,
  iterations: 1,
};

const jsonHeaders = { 'Content-Type': 'application/json' };

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-AUTH-SECRET-KEY': partnerKey,
  };
}

// Admin and SYSTEM log in directly (no OTP)
function directLogin(email, pass) {
  const res = http.post(`${base_url}/user/login`, JSON.stringify({ email, password: pass }), { headers: jsonHeaders });
  check(res, { [`${email} login 200`]: (r) => r.status === 200 });
  return res.json('token');
}

function deposit(token, from, to, amount) {
  const res = http.post(`${base_url}/transaction/deposit`,
    JSON.stringify({ from_account: from, to_account: to, amount }),
    { headers: authHeaders(token) });
  check(res, { [`deposit ${amount} to ${to} is 201`]: (r) => r.status === 201 });
  console.log(`deposit ${from} -> ${to} ${amount}: ${res.status} ${res.body}`);
}

export function setup() {
  const adminToken = directLogin('admin@dmoney.com', '1234');
  const systemToken = directLogin('system@dmoney.com', '1234');
  if (!adminToken || !systemToken) fail('Admin/SYSTEM login failed');

  // Unique 11-digit phone numbers for this run: 01 + 8 digits of time + index
  const stamp = String(Date.now()).slice(-8);
  const roles = [
    ['agent1', 'Agent'], ['agent2', 'Agent'],
    ['customer1', 'Customer'], ['customer2', 'Customer'],
    ['merchant1', 'Merchant'], ['merchant2', 'Merchant'],
  ];

  const users = {};
  roles.forEach(([key, role], i) => {
    const phone = `01${stamp}${i}`;
    const body = {
      name: `k6 ${key}`,
      email: `${gmailBase}+${key}${phone}@gmail.com`,
      password,
      phone_number: phone,
      nid: '1234567890',
      role,
    };

    const createRes = http.post(`${base_url}/user/create`, JSON.stringify(body), { headers: authHeaders(adminToken) });
    check(createRes, { [`create ${key} is 201`]: (r) => r.status === 201 });
    if (createRes.status !== 201) fail(`Could not create ${key}: ${createRes.body}`);

    // New users start as "pending" — activate them
    const id = createRes.json('user.id');
    const activateRes = http.patch(`${base_url}/user/update/${id}`, JSON.stringify({ status: 'active' }), { headers: authHeaders(adminToken) });
    check(activateRes, { [`activate ${key} is 200`]: (r) => r.status === 200 });

    users[key] = { id, role, email: body.email, phone_number: phone, password };
  });

  // Money flow: SYSTEM -> Agents -> Customers
  deposit(systemToken, 'SYSTEM', users.agent1.phone_number, 30000);
  deposit(systemToken, 'SYSTEM', users.agent2.phone_number, 30000);

  // Agents must use their own token to deposit (login + OTP)
  const agent1Token = userLogin(users.agent1.phone_number);
  deposit(agent1Token, users.agent1.phone_number, users.customer1.phone_number, 5000);
  deposit(agent1Token, users.agent1.phone_number, users.customer2.phone_number, 5000);

  return users;
}

function userLogin(phone) {
  http.post(`${base_url}/user/login`, JSON.stringify({ phone_number: phone, password }), { headers: jsonHeaders });
  const res = http.post(`${base_url}/user/verify-otp?env=dev`, JSON.stringify({ identifier: phone, otp: '0000' }), { headers: jsonHeaders });
  return res.json('token');
}

export default function () {}

export function handleSummary(data) {
  const users = data.setup_data;
  console.log(JSON.stringify(users, null, 2));
  return {
    'data/users.json': JSON.stringify(users, null, 2),
  };
}
