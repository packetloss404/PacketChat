import { Suspense } from "react";
import { LoginClient } from "./login-client";

export default function LoginPage() {
  return (
    <div className="sheet">
      <div className="sheet__inner">
        <Suspense fallback={<section className="card auth-card"><div className="eyebrow">Login</div><h1>Loading auth...</h1></section>}>
          <LoginClient />
        </Suspense>
      </div>
    </div>
  );
}
