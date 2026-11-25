// botBehaviorTree.js — compact behavior-tree core for the deathmatch bots.
//
// The tree replaces the old hard-coded if/else combat chain (which could only ever express
// "low hp → cover, otherwise shoot the nearest enemy"). Composite nodes follow the standard
// semantics used by the bot design brief:
//   Selector  : first child that is SUCCESS or RUNNING wins; all FAILURE → FAILURE
//   Sequence  : first child that is FAILURE or RUNNING aborts the sequence
//   Parallel  : ticks every child; any FAILURE → FAILURE, all SUCCESS → SUCCESS, else RUNNING
// A node's tick() receives (bot, context); context is the owning BotBrain and is where
// actions publish their intent (movement, aim, fire).

export const BTStatus = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  RUNNING: 'running',
});

/* Base class: every node is reset-able so a respawn starts from a clean tree state. */
export class BTNode {
  constructor(children = []) {
    this.children = children;
  }
  tick() { return BTStatus.FAILURE; }
  reset() {
    for (const c of this.children) c.reset();
  }
}

/* Selector (a.k.a. fallback / priority): tries children in priority order. */
export class Selector extends BTNode {
  tick(bot, ctx) {
    for (const child of this.children) {
      const status = child.tick(bot, ctx);
      if (status === BTStatus.SUCCESS || status === BTStatus.RUNNING) return status;
    }
    return BTStatus.FAILURE;
  }
}

/* Sequence: all children must succeed, in order. RUNNING keeps the sequence in place. */
export class Sequence extends BTNode {
  tick(bot, ctx) {
    for (const child of this.children) {
      const status = child.tick(bot, ctx);
      if (status === BTStatus.FAILURE || status === BTStatus.RUNNING) return status;
    }
    return BTStatus.SUCCESS;
  }
}

/* Parallel: every child is ticked each frame (used to run fire control and movement
   simultaneously while engaging). */
export class Parallel extends BTNode {
  tick(bot, ctx) {
    let allSuccess = true;
    for (const child of this.children) {
      const status = child.tick(bot, ctx);
      if (status === BTStatus.FAILURE) return BTStatus.FAILURE;
      if (status === BTStatus.RUNNING) allSuccess = false;
    }
    return allSuccess ? BTStatus.SUCCESS : BTStatus.RUNNING;
  }
}

/* Leaf: predicate → SUCCESS / FAILURE. */
export class Condition extends BTNode {
  constructor(predicate) {
    super();
    this.predicate = predicate;
  }
  tick(bot, ctx) {
    return this.predicate(bot, ctx) ? BTStatus.SUCCESS : BTStatus.FAILURE;
  }
}

/* Leaf: action fn → BTStatus (never implicit). */
export class Action extends BTNode {
  constructor(fn) {
    super();
    this.fn = fn;
  }
  tick(bot, ctx) {
    return this.fn(bot, ctx) || BTStatus.FAILURE;
  }
}

/* Decorator: flips SUCCESS / FAILURE. */
export class Inverter extends BTNode {
  constructor(child) {
    super([child]);
    this.child = child;
  }
  tick(bot, ctx) {
    const status = this.child.tick(bot, ctx);
    if (status === BTStatus.SUCCESS) return BTStatus.FAILURE;
    if (status === BTStatus.FAILURE) return BTStatus.SUCCESS;
    return status;
  }
}

/* Decorator: fails for `cooldown` seconds after a SUCCESS (used to rate-limit barks). */
export class Cooldown extends BTNode {
  constructor(child, cooldown) {
    super([child]);
    this.child = child;
    this.cooldown = cooldown;
    this.readyAt = 0;
  }
  tick(bot, ctx) {
    const now = ctx.now || 0;
    if (now < this.readyAt) return BTStatus.FAILURE;
    const status = this.child.tick(bot, ctx);
    if (status === BTStatus.SUCCESS) this.readyAt = now + this.cooldown;
    return status;
  }
  reset() {
    super.reset();
    this.readyAt = 0;
  }
}
