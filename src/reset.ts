try {
  const token = process.env.CONTROL_TOKEN;
  if (!token || token.trim() !== token || /\s/.test(token)) {
    throw new Error("CONTROL_TOKEN must be a nonempty token without whitespace");
  }
  let base: URL;
  try {
    base = new URL(process.env.FINEAR_URL ?? "http://127.0.0.1:4444");
  } catch {
    throw new Error("FINEAR_URL must be an absolute HTTP or HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  ) {
    throw new Error("FINEAR_URL must be an HTTP or HTTPS origin without credentials");
  }
  let response: Response;
  try {
    response = await fetch(new URL("/__test/reset", base), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error("Unable to reach Finear reset endpoint");
  }
  if (!response.ok) throw new Error(`Finear reset failed (HTTP ${response.status})`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Finear reset returned an invalid response");
  }
  if (!body || typeof body !== "object" || !("success" in body) || body.success !== true) {
    throw new Error("Finear reset did not confirm success");
  }
  console.log("Finear fixtures reset");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Finear reset failed");
  process.exitCode = 1;
}

export {};
