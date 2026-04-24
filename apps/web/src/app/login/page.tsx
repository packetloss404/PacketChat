import { Suspense } from "react";
import { LoginClient } from "./login-client";

export default function LoginPage() {
  return (
    <Suspense fallback={<section className="card auth-card"><div className="eyebrow">Login</div><h1>Loading auth...</h1></section>}>
      <LoginClient />
    </Suspense>
  );
}
