import type { MetadataRoute } from "next";

const BASE_URL = "https://cyang.io";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    "",
    "/doclinks",
    "/pricing",
    "/trust",
    "/trust/procurement",
    "/legal",
    "/status",
    "/about",
    "/contact",
    "/report",
    "/privacy",
    "/terms",
  ];

  return routes.map((route) => ({
    url: `${BASE_URL}${route}`,
    lastModified: new Date(),
    changeFrequency: route === "" || route === "/doclinks" || route === "/pricing" ? "weekly" : "monthly",
    priority: route === "" ? 1 : route === "/doclinks" ? 0.9 : route === "/pricing" || route === "/trust" ? 0.8 : 0.6,
  }));
}
