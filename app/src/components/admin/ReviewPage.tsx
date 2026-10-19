"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/context";
import { fetchReview } from "@/lib/chain/admin-client";
import { plainError } from "@/lib/errors";
import type { ReviewReply } from "@/lib/review/flags";
import { ReviewView } from "./ReviewView";

/** Signs one request with the signed-in wallet; the server decides whether it is an admin. */
export function ReviewPage() {
  const auth = useAuth();
  const signer = auth.signer;
  const [review, setReview] = useState<ReviewReply | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!signer) return;
    let live = true;
    fetchReview(signer, auth.getAccessToken)
      .then((r) => live && setReview(r))
      .catch((e) => live && setError(plainError(e)));
    return () => {
      live = false;
    };
  }, [signer, auth.getAccessToken]);

  return <ReviewView review={review} error={error} signedOut={!signer} />;
}
