const EventEmitter = require("events");
const { trackRequest, requestSignal } = require("../src/requestContext");

const fakeResponse = () => Object.assign(new EventEmitter(), { writableFinished: false });

test("outside a request there is no signal", () => {
  expect(requestSignal()).toBeNull();
});

test("a request's signal reaches everything that runs for it, however many awaits later", async () => {
  const res = fakeResponse();
  let seen;
  await new Promise((resolve) => {
    trackRequest({}, res, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      seen = requestSignal();
      resolve();
    });
  });
  expect(seen).toBeInstanceOf(AbortSignal);
  expect(seen.aborted).toBe(false);
});

test("aborted when the app goes away before the answer was sent", () => {
  const res = fakeResponse();
  let signal;
  trackRequest({}, res, () => {
    signal = requestSignal();
  });
  res.emit("close");
  expect(signal.aborted).toBe(true);
});

test("not aborted when the connection closes after the answer was sent", () => {
  const res = fakeResponse();
  let signal;
  trackRequest({}, res, () => {
    signal = requestSignal();
  });
  res.writableFinished = true;
  res.emit("close");
  expect(signal.aborted).toBe(false);
});
