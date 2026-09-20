import assert from "node:assert/strict";
import { test } from "node:test";
import { findWakePhrase, wakePhraseCore } from "./wake-phrase-match.mjs";

const triggers = ["hey openclaw"];

test("greeting is dropped from the matchable core", () => {
  assert.equal(wakePhraseCore("Hey OpenClaw"), "openclaw");
  assert.equal(wakePhraseCore("okay computer"), "computer");
});

test("matches the spellings a small recognizer actually produced for the phrase", () => {
  for (const heard of [
    "Y OPEN CLAW WHAT'S THE WEATHER TO DAY",
    "HAIG OPENED CLAW",
    "HEY OPEN CAR WHAT'S THE WEATHER",
    "HAY OPENCLOTH SET A TIMEER",
  ]) {
    assert.equal(findWakePhrase(heard, triggers), "hey openclaw", heard);
  }
  assert.equal(findWakePhrase("okay computer lights off", ["computer"]), "computer");
});

// Known limit of the two-edit tolerance that catches real misspellings: near-homophones such
// as "open Claude" or "open a claim" also match. Accepted for an invented wake word.
test("ordinary speech does not match", () => {
  for (const heard of [
    "THE YELLOW LAMPS WOULD LIGHT UP HERE AND THERE",
    "PLEASE OPEN THE CALENDAR AND THE CLOSET",
    "ASK THE COMPUTER ABOUT THE WEATHER",
    "HEY",
    "",
  ]) {
    assert.equal(findWakePhrase(heard, triggers), undefined, heard);
  }
});

test("very short triggers are ignored instead of matching everything", () => {
  assert.equal(findWakePhrase("go to the store", ["go"]), undefined);
});
