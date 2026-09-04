import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAuthEmailMessage, deliverAuthEmail, type AuthEmailSettings } from "../src/email";

const inviteUrl = "https://packetchat.test/login?invite=secret-token-value";

function settings(overrides: Partial<AuthEmailSettings> = {}): AuthEmailSettings {
  return {
    provider: "manual",
    from: "PacketChat <noreply@example.test>",
    timeoutMs: 50,
    resendApiKey: "",
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: "",
    smtpPassword: "",
    smtpRejectUnauthorized: true,
    ...overrides
  };
}

function inviteMessage() {
  return buildAuthEmailMessage({ to: "invitee@example.test", kind: "invite", url: inviteUrl, expiresSeconds: 604_800 });
}

const failingTransports = {
  fetch: (() => {
    throw new Error("fetch must not be called");
  }) as unknown as typeof fetch,
  sendSmtp: () => {
    throw new Error("smtp must not be called");
  }
};

test("manual mode sends nothing and leaves the token with the caller", async () => {
  const message = inviteMessage();
  const delivery = await deliverAuthEmail(message, settings({ provider: "manual" }), failingTransports);

  assert.deepEqual(delivery, { provider: "manual", status: "manual" });
  assert.ok(message.text.includes(inviteUrl), "the manual-delivery body still carries the invite URL");
  assert.ok(message.html.includes(inviteUrl));
});

test("the message carries the link, the action and the expiry for both kinds", () => {
  const invite = buildAuthEmailMessage({ to: "a@example.test", kind: "invite", url: inviteUrl, expiresSeconds: 604_800 });
  assert.equal(invite.subject, "Accept your PacketChat invite");
  assert.ok(invite.text.includes("accept your invite"));
  assert.ok(invite.text.includes("7 days"));

  const reset = buildAuthEmailMessage({ to: "a@example.test", kind: "password_reset", url: "https://packetchat.test/login?reset=t", expiresSeconds: 3_600 });
  assert.equal(reset.subject, "Reset your PacketChat password");
  assert.ok(reset.text.includes("reset your password"));
  assert.ok(reset.text.includes("1 hour"));
});

test("provider selection routes to the configured transport only", async () => {
  let resendCalls = 0;
  const viaResend = await deliverAuthEmail(inviteMessage(), settings({ provider: "resend", resendApiKey: "re_test_key" }), {
    fetch: (async (_url, init) => {
      resendCalls += 1;
      const body = JSON.parse(String((init as RequestInit).body)) as { from: string; to: string };
      assert.equal(body.from, "PacketChat <noreply@example.test>");
      assert.equal(body.to, "invitee@example.test");
      return new Response(JSON.stringify({ id: "re_123" }), { status: 200 });
    }) as typeof fetch,
    sendSmtp: failingTransports.sendSmtp
  });

  assert.equal(resendCalls, 1);
  assert.deepEqual(viaResend, { provider: "resend", status: "sent", id: "re_123" });

  let smtpCalls = 0;
  const viaSmtp = await deliverAuthEmail(inviteMessage(), settings({ provider: "smtp", smtpHost: "relay.example.test" }), {
    fetch: failingTransports.fetch,
    sendSmtp: async (message) => {
      smtpCalls += 1;
      assert.equal(message.to, "invitee@example.test");
      return "<message-id@relay>";
    }
  });

  assert.equal(smtpCalls, 1);
  assert.deepEqual(viaSmtp, { provider: "smtp", status: "sent", id: "<message-id@relay>" });
});

test("a configured provider with missing settings fails instead of masquerading as manual", async () => {
  const resend = await deliverAuthEmail(inviteMessage(), settings({ provider: "resend", resendApiKey: "" }), failingTransports);
  assert.equal(resend.provider, "resend");
  assert.equal(resend.status, "failed");
  assert.match(resend.message ?? "", /RESEND_API_KEY/);

  const smtp = await deliverAuthEmail(inviteMessage(), settings({ provider: "smtp", smtpHost: "" }), failingTransports);
  assert.equal(smtp.provider, "smtp");
  assert.equal(smtp.status, "failed");
  assert.match(smtp.message ?? "", /SMTP_HOST/);
});

test("a rejected send surfaces as failed with the relay's reason", async () => {
  const delivery = await deliverAuthEmail(inviteMessage(), settings({ provider: "resend", resendApiKey: "re_test_key" }), {
    fetch: (async () => new Response(JSON.stringify({ message: "The example.test domain is not verified" }), { status: 422 })) as typeof fetch
  });

  assert.equal(delivery.status, "failed");
  assert.match(delivery.message ?? "", /Resend returned 422/);
  assert.match(delivery.message ?? "", /domain is not verified/);
});

test("a transport that throws surfaces as failed rather than being swallowed", async () => {
  const delivery = await deliverAuthEmail(inviteMessage(), settings({ provider: "smtp", smtpHost: "relay.example.test" }), {
    sendSmtp: async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:587");
    }
  });

  assert.equal(delivery.provider, "smtp");
  assert.equal(delivery.status, "failed");
  assert.match(delivery.message ?? "", /ECONNREFUSED/);
});

test("a relay that never answers times out and aborts instead of hanging the request", async () => {
  let aborted = false;
  const started = Date.now();
  const delivery = await deliverAuthEmail(inviteMessage(), settings({ provider: "smtp", smtpHost: "relay.example.test", timeoutMs: 25 }), {
    sendSmtp: (_message, _settings, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<string>(() => {});
    }
  });

  assert.equal(delivery.status, "failed");
  assert.match(delivery.message ?? "", /timed out after 25ms/);
  assert.equal(aborted, true, "the send is aborted so the socket is not left open");
  assert.ok(Date.now() - started < 5_000, "the caller is released on the timeout, not on the relay");
});

test("a stalled HTTP provider is aborted on the same budget", async () => {
  let aborted = false;
  const delivery = await deliverAuthEmail(inviteMessage(), settings({ provider: "resend", resendApiKey: "re_test_key", timeoutMs: 25 }), {
    fetch: ((_url: unknown, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch
  });

  assert.equal(delivery.status, "failed");
  assert.match(delivery.message ?? "", /timed out after 25ms/);
  assert.equal(aborted, true);
});

test("credentials never reach the delivery message", async () => {
  const smtpPassword = "super-secret-relay-password";
  const delivery = await deliverAuthEmail(inviteMessage(), settings({ provider: "smtp", smtpHost: "relay.example.test", smtpUser: "packetchat", smtpPassword }), {
    sendSmtp: async () => {
      throw new Error(`535 authentication failed for AUTH PLAIN ${smtpPassword}`);
    }
  });

  assert.equal(delivery.status, "failed");
  assert.ok(!delivery.message?.includes(smtpPassword), "the relay password is redacted out of the reported failure");
  assert.match(delivery.message ?? "", /\[redacted\]/);
});

test("no delivery outcome carries the invite token", async () => {
  const outcomes = await Promise.all([
    deliverAuthEmail(inviteMessage(), settings({ provider: "manual" })),
    deliverAuthEmail(inviteMessage(), settings({ provider: "resend", resendApiKey: "" })),
    deliverAuthEmail(inviteMessage(), settings({ provider: "smtp", smtpHost: "relay.example.test" }), {
      sendSmtp: async () => {
        throw new Error(`relay rejected ${inviteUrl}`);
      }
    })
  ]);

  for (const outcome of outcomes) {
    assert.ok(!JSON.stringify(outcome).includes("secret-token-value"), "delivery results are safe to log and audit");
  }
});
