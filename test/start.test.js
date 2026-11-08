/**
 * Starting the server: start() as start.js and the Docker image call it,
 * run here in this process so coverage measures it, with stand-ins for the
 * process's signals and its exit. test/startup.test.js boots the real thing
 * in a process of its own.
 */
const http = require("http");
const { EventEmitter, once } = require("events");

const ENV = ["PORT", "CACHE_SEARCH_TTL", "IMDB_DATASETS", "ANIME_DATASET"];
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
afterEach(() => {
  ENV.forEach((name) => (saved[name] === undefined ? delete process.env[name] : (process.env[name] = saved[name])));
  jest.restoreAllMocks();
});

const health = (port) =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });

test("says what the host set and what it could not read, starts IMDb's data, the anime database and profiles, listens, and on SIGTERM stops cleanly", async () => {
  process.env.CACHE_SEARCH_TTL = "a day";
  delete process.env.IMDB_DATASETS;
  delete process.env.ANIME_DATASET;
  await jest.isolateModulesAsync(async () => {
    const { start } = require("../server");
    const imdb = require("../src/metadata/imdb");
    const animeDb = require("../src/metadata/animeDb");
    const profiles = require("../src/profiles");
    const { hostConfig } = require("../src/hostConfig");
    jest.spyOn(imdb, "start").mockImplementation(() => {});
    jest.spyOn(animeDb, "start").mockImplementation(() => {});
    jest.spyOn(profiles, "start").mockResolvedValue();
    jest.spyOn(profiles, "stop").mockResolvedValue();
    const log = { log: jest.fn(), warn: jest.fn() };
    const signals = new EventEmitter();
    let exited;
    const exit = jest.fn();
    const done = new Promise((resolve) => (exited = resolve));
    exit.mockImplementation(exited);

    const server = start({ port: 0, signals, exit, log });
    await once(server, "listening");
    const { port } = server.address();
    expect(log.warn).toHaveBeenCalledWith('[config] CACHE_SEARCH_TTL="a day" is not a duration such as 90s, 15m, 6h or 7d; using 24h');
    expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/^\[cache\] memory \(64 MB\), prefix "youstream": searches 1d/));
    expect(log.log).toHaveBeenCalledWith(`YouStream addon listening on port ${port}`);
    expect(imdb.start).toHaveBeenCalled();
    expect(animeDb.start).toHaveBeenCalled();
    expect(profiles.start).toHaveBeenCalledWith(hostConfig.profiles);
    expect(await health(port)).toBe(200);

    signals.emit("SIGTERM");
    await done;
    expect(exit).toHaveBeenCalledWith(0);
    expect(profiles.stop).toHaveBeenCalled();
    expect(server.listening).toBe(false);
  });
});

test("by default: the port from the environment, the process's own signals, and the console", async () => {
  process.env.PORT = "0";
  process.env.IMDB_DATASETS = "off";
  process.env.ANIME_DATASET = "off";
  await jest.isolateModulesAsync(async () => {
    const { start } = require("../server");
    const imdb = require("../src/metadata/imdb");
    const animeDb = require("../src/metadata/animeDb");
    jest.spyOn(imdb, "start");
    jest.spyOn(animeDb, "start");
    const said = jest.spyOn(console, "log").mockImplementation(() => {});
    const before = process.listeners("SIGTERM");
    const server = start();
    try {
      await once(server, "listening");
      expect(said).toHaveBeenCalledWith(`YouStream addon listening on port ${server.address().port}`);
      // IMDb's data and the anime database are the host's to turn off.
      expect(imdb.start).not.toHaveBeenCalled();
      expect(animeDb.start).not.toHaveBeenCalled();
      expect(process.listeners("SIGTERM")).toHaveLength(before.length + 1);
    } finally {
      process.listeners("SIGTERM")
        .filter((fn) => !before.includes(fn))
        .forEach((fn) => process.removeListener("SIGTERM", fn));
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("start.js starts the server, and does nothing else", () => {
  jest.isolateModules(() => {
    const start = jest.fn();
    jest.doMock("../server", () => ({ start }));
    require("../start");
    expect(start).toHaveBeenCalledWith();
  });
});
