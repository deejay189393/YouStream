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
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const startupLog = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start in time")), 15000);
      child.stdout.on("data", (buf) => {
        const line = buf.toString();
        if (line.includes("listening")) {
          clearTimeout(timer);
          resolve(line);
        }
      });
      child.on("error", reject);
    });

    expect(startupLog).toContain(String(PORT));

    const status = await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: PORT, path: "/health" }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
    });

    expect(status).toBe(200);
  }, 20000);
});
