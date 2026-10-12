const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

/**
 * Boots the real server the way `npm start` (and the Docker image) does,
 * as a separate process, and checks it binds the port from the
 * environment. This is what Railway relies on, so it is worth testing for
 * real rather than only importing the Express app.
 */
describe("server startup", () => {
  let child;
  const PORT = 34568;

  afterEach(() => {
    if (child && !child.killed) child.kill("SIGKILL");
  });

  test("listens on the PORT given in the environment and serves /health", async () => {
    child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      // The cache settings this machine happens to have are left out, and one
      // is mistyped on purpose.
      env: { ...process.env, PORT: String(PORT), REDIS_URL: "", CACHE_STORE: "", CACHE_SEARCH_TTL: "a day" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (buf) => {
      stderr += buf.toString();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start in time")), 15000);
      child.stdout.on("data", (buf) => {
        stdout += buf.toString();
        if (stdout.includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("error", reject);
    });

    expect(stdout).toContain(`listening on port ${PORT}`);
    // What the cache is, said once at startup; a setting it could not read,
    // said plainly, with the default it used instead.
    expect(stdout).toContain('[cache] memory (64 MB), prefix "youstream": searches 1d');

    const status = await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: PORT, path: "/health" }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
    });

    expect(status).toBe(200);
    // Read after a round trip, so the pipe has surely delivered it.
    expect(stderr).toContain('[config] CACHE_SEARCH_TTL="a day" is not a duration such as 90s, 15m, 6h or 7d; using 24h');
  }, 20000);
});
