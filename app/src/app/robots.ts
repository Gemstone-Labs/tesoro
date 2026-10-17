import type { MetadataRoute } from "next";
import { robotsFor } from "@/lib/robots";
import { SITE_INDEXABLE, SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return robotsFor(SITE_URL, SITE_INDEXABLE);
}
