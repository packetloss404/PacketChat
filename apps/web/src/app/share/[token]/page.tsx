import type { Metadata } from "next";
import { ShareView } from "./share-view";

export const metadata: Metadata = {
  title: "Shared conversation",
  robots: { index: false, follow: false },
  referrer: "no-referrer"
};

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="share-view">
      <div className="share-view__inner">
        <ShareView token={token} />
      </div>
    </div>
  );
}
