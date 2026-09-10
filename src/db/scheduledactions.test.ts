import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.LOOPDOG_DB = join(mkdtempSync(join(tmpdir(), "loopdog-test-")), "test.sqlite");

type Module = typeof import("./scheduledactions");

let loaded: Promise<Module> | null = null;

function actions(): Promise<Module> {
  loaded ??= (async () => {
    const { migrate } = await import("./index");
    migrate();
    return import("./scheduledactions");
  })();
  return loaded;
}

const past = (): string => new Date(Date.now() - 60_000).toISOString();
const future = (): string => new Date(Date.now() + 60 * 60_000).toISOString();

test("a fired one-shot action doesn't fire again", async () => {
  const { createScheduledAction, listDueActions, markFired } = await actions();

  const created = createScheduledAction("plug_on", "washing machine", past(), "cheapest 3h window", null);
  assert.ok(
    listDueActions().some((a) => a.id === created.id),
    "starts out due",
  );

  markFired(created.id);
  assert.equal(
    listDueActions().some((a) => a.id === created.id),
    false,
    "an appliance must not be switched on twice because the scheduler ticked twice",
  );
});

test("a recurring action rolls forward and stays pending instead of being consumed", async () => {
  const { createScheduledAction, getScheduledAction, markFired } = await actions();

  const created = createScheduledAction("vacuum_start", null, past(), null, "weekly");
  const before = getScheduledAction(created.id)!.run_at;
  markFired(created.id);

  const after = getScheduledAction(created.id)!;
  assert.equal(after.fired_at, null, "a weekly action isn't finished after one run");
  assert.ok(Date.parse(after.run_at) > Date.parse(before), "it moved to the next occurrence");
});

test("pending actions list soonest-first and drop out once cancelled", async () => {
  const { createScheduledAction, listScheduledActions, cancelScheduledAction } = await actions();

  const later = createScheduledAction("plug_off", "heater", new Date(Date.now() + 7_200_000).toISOString(), null, null);
  const sooner = createScheduledAction("plug_on", "heater", future(), null, null);

  const pending = listScheduledActions().filter((a) => a.id === later.id || a.id === sooner.id);
  assert.deepEqual(
    pending.map((a) => a.id),
    [sooner.id, later.id],
  );

  assert.ok(cancelScheduledAction(later.id));
  assert.equal(
    listScheduledActions().some((a) => a.id === later.id),
    false,
  );
  assert.equal(cancelScheduledAction(later.id), null, "cancelling twice is not an error");
});

test("a scheduled action stores the device name, not a resolved id", async () => {
  const { createScheduledAction, getScheduledAction } = await actions();
  // Storing an id would silently act on the wrong thing if a device were
  // renamed or replaced; a stale name fails loudly at fire time instead.
  const created = createScheduledAction("plug_on", "desk lamp", future(), null, null);
  assert.equal(getScheduledAction(created.id)!.target, "desk lamp");
});

test("noisy actions are marked as such, silent ones aren't", async () => {
  const { NOISY_ACTIONS } = await actions();
  // The whole reason quiet hours are applied per-action: a plug at 03:00 is
  // silent and often the entire point (cheap power); a vacuum is not.
  assert.deepEqual(NOISY_ACTIONS, ["vacuum_start"]);
  assert.ok(!NOISY_ACTIONS.includes("plug_on" as never));
});
