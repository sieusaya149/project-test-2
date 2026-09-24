import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

async function withServer(options, fn) {
  const server = createApp(options).listen(0);
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function register(base, phone) {
  const otpRes = await fetch(`${base}/auth/otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  assert.equal(otpRes.status, 200, `request OTP for ${phone}`);
  const { code } = await otpRes.json();

  const verifyRes = await fetch(`${base}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, code }),
  });
  assert.equal(verifyRes.status, 200, `verify ${phone}`);
  return (await verifyRes.json()).token;
}

async function api(base, path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: data };
}

/** Registers both users already done by caller; makes `aPhone` and `bPhone` friends. */
async function befriend(base, aToken, aPhone, bToken, bPhone) {
  const sent = await api(base, "/friends/requests", {
    method: "POST",
    token: aToken,
    body: { phone: bPhone },
  });
  assert.equal(sent.status, 201, `friend request ${aPhone} -> ${bPhone}`);
  const accepted = await api(base, `/friends/requests/${sent.body.id}/accept`, {
    method: "POST",
    token: bToken,
  });
  assert.equal(accepted.status, 200, `accept ${aPhone} -> ${bPhone}`);
}

function wsUrl(base, port, token) {
  return `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => {
      reject(new Error("websocket connection failed"));
    });
  });
}

/** Resolves with the next parsed text message on the socket. */
function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      cleanup();
      resolve(JSON.parse(event.data));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before a message arrived"));
    };
    const cleanup = () => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

test("POST /groups creates a group with the creator as admin and friends as members", async () => {
  await withServer({}, async (base) => {
    const alice = await register(base, "0911010101");
    const bob = await register(base, "0912020202");
    const carol = await register(base, "0913030303");
    await befriend(base, alice, "0911010101", bob, "0912020202");
    await befriend(base, alice, "0911010101", carol, "0913030303");

    const res = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "weekend crew", members: ["0912020202", "0913030303"] },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id, "group must have an id");
    assert.equal(res.body.type, "group");
    assert.equal(res.body.name, "weekend crew");
    assert.equal(res.body.admin, "0911010101");
    assert.deepEqual(
      [...res.body.participants].sort(),
      ["0911010101", "0912020202", "0913030303"],
    );
  });
});

test("POST /groups validates name, members, range, uniqueness, and friendship", async () => {
  await withServer({}, async (base) => {
    const alice = await register(base, "0914040404");
    const bob = await register(base, "0915050505");
    const stranger = await register(base, "0916060606");
    await befriend(base, alice, "0914040404", bob, "0915050505");

    const noName = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { members: ["0915050505"] },
    });
    assert.equal(noName.status, 400);
    assert.equal(noName.body.error, "group name is required");

    const notArray = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "g", members: "0915050505" },
    });
    assert.equal(notArray.status, 400);
    assert.equal(notArray.body.error, "members must be an array of phone numbers");

    const tooFew = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "g", members: [] },
    });
    assert.equal(tooFew.status, 400);
    assert.equal(tooFew.body.error, "a group must have between 2 and 100 members");

    const duplicate = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "g", members: ["0915050505", "0915050505"] },
    });
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.body.error, "members must be unique");

    const self = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "g", members: ["0914040404"] },
    });
    assert.equal(self.status, 400);
    assert.equal(self.body.error, "the creator is already a member");

    const notFriend = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "g", members: ["0916060606"] },
    });
    assert.equal(notFriend.status, 403);
    assert.equal(notFriend.body.error, "members must be friends");

    const unknown = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "g", members: ["0919999999"] },
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "user not found");

    // 100 members + the creator = 101, which exceeds the 100-member limit.
    const many = Array.from({ length: 100 }, (_, i) => `091${String(7000000 + i)}`);
    const tooMany = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "g", members: many },
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error, "a group must have between 2 and 100 members");
  });
});

test("only the group admin can add or remove members", async () => {
  await withServer({}, async (base) => {
    const alice = await register(base, "0921010101");
    const bob = await register(base, "0922020202");
    const carol = await register(base, "0923030303");
    const dave = await register(base, "0924040404");
    await befriend(base, alice, "0921010101", bob, "0922020202");
    await befriend(base, alice, "0921010101", carol, "0923030303");
    await befriend(base, alice, "0921010101", dave, "0924040404");

    const created = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "team", members: ["0922020202", "0923030303"] },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    // Bob is a member but not the admin.
    const bobAdds = await api(base, `/groups/${id}/members`, {
      method: "POST",
      token: bob,
      body: { phone: "0924040404" },
    });
    assert.equal(bobAdds.status, 403);
    assert.equal(bobAdds.body.error, "only the group admin can add members");

    const bobRemoves = await api(base, `/groups/${id}/members/0923030303`, {
      method: "DELETE",
      token: bob,
    });
    assert.equal(bobRemoves.status, 403);
    assert.equal(bobRemoves.body.error, "only the group admin can remove members");

    // The admin can add and remove.
    const addDave = await api(base, `/groups/${id}/members`, {
      method: "POST",
      token: alice,
      body: { phone: "0924040404" },
    });
    assert.equal(addDave.status, 200);
    assert.ok(addDave.body.participants.includes("0924040404"));

    const removeCarol = await api(base, `/groups/${id}/members/0923030303`, {
      method: "DELETE",
      token: alice,
    });
    assert.equal(removeCarol.status, 200);
    assert.ok(!removeCarol.body.participants.includes("0923030303"));
  });
});

test("adding/removing members enforces friendship, membership, and size limits", async () => {
  await withServer({}, async (base) => {
    const alice = await register(base, "0925050505");
    const bob = await register(base, "0926060606");
    const carol = await register(base, "0927070707");
    const stranger = await register(base, "0928080808");
    await befriend(base, alice, "0925050505", bob, "0926060606");
    await befriend(base, alice, "0925050505", carol, "0927070707");

    const created = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "duo", members: ["0926060606"] },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const dupAdd = await api(base, `/groups/${id}/members`, {
      method: "POST",
      token: alice,
      body: { phone: "0926060606" },
    });
    assert.equal(dupAdd.status, 409);
    assert.equal(dupAdd.body.error, "already a member");

    const nonFriend = await api(base, `/groups/${id}/members`, {
      method: "POST",
      token: alice,
      body: { phone: "0928080808" },
    });
    assert.equal(nonFriend.status, 403);
    assert.equal(nonFriend.body.error, "can only add friends");

    const unknown = await api(base, `/groups/${id}/members`, {
      method: "POST",
      token: alice,
      body: { phone: "0929999999" },
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "user not found");

    // Removing the only other member (would drop below 2) is refused.
    const removeLast = await api(base, `/groups/${id}/members/0926060606`, {
      method: "DELETE",
      token: alice,
    });
    assert.equal(removeLast.status, 400);
    assert.equal(removeLast.body.error, "a group must have at least 2 members");

    const removeMissing = await api(base, `/groups/${id}/members/0927070707`, {
      method: "DELETE",
      token: alice,
    });
    assert.equal(removeMissing.status, 404);
    assert.equal(removeMissing.body.error, "member not found");

    const removeSelf = await api(base, `/groups/${id}/members/0925050505`, {
      method: "DELETE",
      token: alice,
    });
    assert.equal(removeSelf.status, 400);
    assert.equal(removeSelf.body.error, "the admin cannot remove themselves");
  });
});

test("every member receives group messages in real time over WebSocket", async () => {
  await withServer({}, async (base, port) => {
    const alice = await register(base, "0931010101");
    const bob = await register(base, "0932020202");
    const carol = await register(base, "0933030303");
    await befriend(base, alice, "0931010101", bob, "0932020202");
    await befriend(base, alice, "0931010101", carol, "0933030303");

    const created = await api(base, "/groups", {
      method: "POST",
      token: alice,
      body: { name: "trio", members: ["0932020202", "0933030303"] },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const aliceWs = await connectWs(wsUrl(base, port, alice));
    const bobWs = await connectWs(wsUrl(base, port, bob));
    const carolWs = await connectWs(wsUrl(base, port, carol));
    try {
      const bobReceives = nextMessage(bobWs);
      const carolReceives = nextMessage(carolWs);
      const startedAt = Date.now();
      aliceWs.send(JSON.stringify({ type: "send", conversationId: id, text: "hello group" }));

      const [toBob, toCarol] = await Promise.all([bobReceives, carolReceives]);
      const elapsed = Date.now() - startedAt;

      assert.equal(toBob.type, "message");
      assert.equal(toBob.message.sender, "0931010101");
      assert.equal(toBob.message.text, "hello group");
      assert.equal(toBob.message.conversationId, id);

      assert.equal(toCarol.type, "message");
      assert.equal(toCarol.message.sender, "0931010101");
      assert.equal(toCarol.message.text, "hello group");
      assert.ok(elapsed < 1000, `delivery took ${elapsed}ms`);

      // A non-admin member can also send, and everyone else receives it.
      const aliceReceives = nextMessage(aliceWs);
      const carolReceivesAgain = nextMessage(carolWs);
      bobWs.send(JSON.stringify({ type: "send", conversationId: id, text: "hey all" }));

      const [toAlice, toCarolAgain] = await Promise.all([
        aliceReceives,
        carolReceivesAgain,
      ]);
      assert.equal(toAlice.message.sender, "0932020202");
      assert.equal(toAlice.message.text, "hey all");
      assert.equal(toCarolAgain.message.text, "hey all");

      // Group messages are persisted and readable by any member.
      const history = await api(base, `/conversations/${id}/messages`, {
        token: carol,
      });
      assert.equal(history.status, 200);
      assert.equal(history.body.messages.length, 2);
      assert.equal(history.body.messages[0].text, "hey all");
      assert.equal(history.body.messages[1].text, "hello group");
    } finally {
      aliceWs.close();
      bobWs.close();
      carolWs.close();
    }
  });
});
