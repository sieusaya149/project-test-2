import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

const PHONE = "0901234567";
const MINUTE = 60 * 1000;

/** A controllable clock so expiry/lockout tests don't wait in real time. */
function makeClock(start = Date.now()) {
  const clock = { t: start };
  return { clock, now: () => clock.t };
}

async function withServer(options, fn) {
  const server = createApp(options).listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function requestOtp(base, phone = PHONE) {
  const res = await fetch(`${base}/auth/otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  return { status: res.status, body: await res.json() };
}

async function verify(base, phone, code) {
  const res = await fetch(`${base}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, code }),
  });
  return { status: res.status, body: await res.json() };
}

test("POST /auth/otp returns a 6-digit code", async () => {
  await withServer({}, async (base) => {
    const { status, body } = await requestOtp(base);
    assert.equal(status, 200);
    assert.match(body.code, /^\d{6}$/);
  });
});

test("POST /auth/otp rejects a missing/invalid phone", async () => {
  await withServer({}, async (base) => {
    for (const phone of [undefined, "123", "not-a-phone", ""]) {
      const res = await fetch(`${base}/auth/otp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      assert.equal(res.status, 400, `expected 400 for phone=${phone}`);
      const body = await res.json();
      assert.equal(body.error, "invalid phone number");
    }
  });
});

test("POST /auth/verify succeeds with the correct code and returns a JWT", async () => {
  await withServer({}, async (base) => {
    const { body: otp } = await requestOtp(base);
    const { status, body } = await verify(base, PHONE, otp.code);
    assert.equal(status, 200);
    assert.equal(body.phone, PHONE);

    const parts = body.token.split(".");
    assert.equal(parts.length, 3, "expected a 3-part JWT");

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    assert.equal(header.alg, "HS256");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    assert.equal(payload.sub, PHONE);
    assert.ok(payload.exp > payload.iat);
  });
});

test("POST /auth/verify rejects an expired code", async () => {
  const { clock, now } = makeClock();
  await withServer({ now }, async (base) => {
    const { body: otp } = await requestOtp(base);
    clock.t += 5 * MINUTE + 1;
    const { status, body } = await verify(base, PHONE, otp.code);
    assert.equal(status, 400);
    assert.equal(body.error, "code expired or not requested");
  });
});

test("POST /auth/verify rejects a wrong code", async () => {
  await withServer({}, async (base) => {
    await requestOtp(base);
    const { status } = await verify(base, PHONE, "000000");
    assert.equal(status, 401);
  });
});

test("more than 5 wrong codes locks the phone for 15 minutes", async () => {
  const { clock, now } = makeClock();
  await withServer({ now }, async (base) => {
    const { body: otp } = await requestOtp(base);

    for (let i = 0; i < 5; i++) {
      const { status } = await verify(base, PHONE, "000000");
      assert.equal(status, 401, `wrong attempt ${i + 1} should be 401`);
    }

    // The 6th wrong code trips the lock.
    const sixth = await verify(base, PHONE, "000000");
    assert.equal(sixth.status, 429);
    assert.match(sixth.body.error, /locked/);

    // Even the correct code is rejected while locked.
    const locked = await verify(base, PHONE, otp.code);
    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /locked/);
  });
});

test("the lock expires so a retry works", async () => {
  const { clock, now } = makeClock();
  await withServer({ now }, async (base) => {
    await requestOtp(base);
    for (let i = 0; i < 6; i++) {
      await verify(base, PHONE, "000000");
    }
    // While locked, even a fresh code must be rejected.
    const { body: otpWhileLocked } = await requestOtp(base);
    const stillLocked = await verify(base, PHONE, otpWhileLocked.code);
    assert.equal(stillLocked.status, 429);

    // Advance past the 15-minute lock, request a fresh code, and verify.
    clock.t += 15 * MINUTE + 1;
    const { body: otp } = await requestOtp(base);
    const { status, body } = await verify(base, PHONE, otp.code);
    assert.equal(status, 200);
    assert.ok(body.token);
  });
});

test("a correct code resets the wrong-attempt counter", async () => {
  await withServer({}, async (base) => {
    // A few wrong guesses, then a correct one resets the counter.
    const { body: otp } = await requestOtp(base);
    for (let i = 0; i < 4; i++) {
      const { status } = await verify(base, PHONE, "000000");
      assert.equal(status, 401);
    }
    assert.equal((await verify(base, PHONE, otp.code)).status, 200);

    // With a fresh code we get a full 5 wrong guesses before locking,
    // proving the earlier guesses were not carried over.
    await requestOtp(base);
    for (let i = 0; i < 5; i++) {
      const { status } = await verify(base, PHONE, "000000");
      assert.equal(status, 401, `guess ${i + 1} after reset should be 401`);
    }
    const locked = await verify(base, PHONE, "000000");
    assert.equal(locked.status, 429);
  });
});
