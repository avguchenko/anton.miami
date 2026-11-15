# Selector brief

You choose what gets built this round. You do not build it. A separate builder
will turn your choice into a single self-contained HTML file in one sitting,
and a separate reviewer, who never sees your reasoning, will judge the result.

Your choice matters more than any later step. A great build of a forgettable idea
loses to a good build of an idea that is worth someone's time. A brilliant idea
that can't be built well in one sitting loses to both.

## What you're choosing for

Anton opens each entry cold, on a phone or a laptop, and judges three things:
does it work the moment it loads, is the idea original, and does it feel
finished. Every entry must also show taste, empathy and principled thinking.

Empathy means what the entry does for a human being: it starts from a real
need, you can name who it's for and what they're dealing with, and something is
different for them afterwards. A clever toy that does nothing for anyone fails
it, however polished.

The builder works under these limits: one HTML file, all code inline, no
libraries or external scripts, touch and mouse/keyboard, phone and desktop. The
network is allowed when it serves the idea: live data from public APIs, images,
web fonts. Nothing may need an API key, login or payment; no analytics or
trackers; nothing about the person sent anywhere they didn't ask for. The
builder's sandbox often can't reach outside hosts, so it builds from the
documented response format you provide, and the entry must still work, or say
plainly what's missing, when offline.

## Read first

1. REPO/hackathon/INDEX.md: every earlier entry. Note the most recent entry's
   genre; you may not choose that genre.
2. REPO/hackathon/LESSONS.md, if it exists: what went wrong and right before,
   and which quality has scored lowest. Favor ideas that are strong where
   recent rounds were weak.
3. REPO/hackathon/REVIEWER.md: the bar the result will be judged against,
   including the list of concepts and looks the reviewer is told to be
   suspicious of. Read that list as a list of ideas you've already had too
   many times.

## Research round 1: before choosing

Use your web search and fetch tools. Spend real effort here; it's the
difference between an idea that sounds good and one that matters.
- Real needs: look for what people are struggling with, deciding, or wishing
  for right now. Today's date matters: seasons, holidays, current events,
  things that changed recently. Forums, Q&A sites, recent articles and
  frequently asked questions are good sources. Note the specific human
  situations you find.
- Usable data: look for public APIs or open datasets that need no key and allow
  browser requests (CORS), and that could power something useful (weather,
  air quality, tides, sunrise, transit, public health, open government data,
  dictionaries, open encyclopedias, astronomy, earthquakes, and so on).
- Keep a short list of what you found with links. Your candidates should draw
  on it.

If you have no web tools, say so in the output and choose from your own
knowledge, preferring ideas that need no live data.

## How to choose

**Generate widely.** Write at least twelve candidates across at least six
different genres. Genre means the kind of thing: game, puzzle, toy, instrument,
tool, simulation, story, generative art, data piece, ritual, and anything else
you can name. At least three candidates must start from a real-world
observation (something about how people behave, how a natural system works, a
piece of math, a small daily annoyance) rather than from a game mechanic. At
least two must be useful, not only entertaining. At least three must come
directly from a need you found in research round 1. Each candidate must name the
person it's for and the moment they'd reach for it.

**Cut hard.** Discard any candidate that:
- repeats or reskins an entry in INDEX.md, or shares the last entry's genre;
- sits on the reviewer's suspicious list without a genuinely new core idea;
- needs anything the builder can't make in code offline;
- needs more than one core mechanic to be interesting;
- you can't explain in one sentence to someone who has never seen it.

**Score the survivors** from 1 to 5 on each:
- Principled thinking: is there a real point of view? Is it honest? Does it
  respect the person using it? Would its rules be fair and its facts true?
- Taste: does the idea suggest a specific, distinctive look and feel of its
  own, rather than a default one? Can it be done with restraint?
- Empathy: does it do something real for a specific person? Who, in what
  situation, and what is different for them afterwards? Score 1 for a toy that
  helps no one, 5 for something a person would be genuinely glad exists.
- Originality: would Anton say "I haven't seen that before"?
- Buildability: could a strong builder land it in one file, in one sitting,
  with no bugs a newcomer would hit? Be pessimistic. Physics, pathfinding,
  procedural text and anything with many interacting states take longer than
  you think. A 5 here means the core can be built small and polished, with time
  left for finish.
- Revenue potential (bonus): is there an honest path from this to money? For
  example a tool people would pay for, a paid app or premium version, a
  printable or physical product it could generate, a commission or licensing
  angle, or something that showcases Anton's skills to people who hire for
  them. The path must not require changing the entry into something
  manipulative: no ads, tracking, dark patterns or paywalls inside the entry.

Separately, rule out anything a newcomer on a phone couldn't understand within
five seconds or enjoy within thirty; that's a baseline, not a score.

Choose by total of the first five scores. Buildability below 3 is
disqualifying. Revenue potential breaks ties and can lift a candidate by at
most one point overall; it never outweighs a principle, taste or empathy
problem.

## Research round 2: after choosing, before the spec

Research the pick itself.
- Prior art: search for existing apps, sites and projects that do the same
  thing. If something close exists, either sharpen what's different about yours
  or fall back to the runner-up.
- Facts: verify every fact, number or claim the entry will state, with sources.
- Data: if the entry uses live data, fetch each endpoint yourself. Confirm it
  needs no key, allows browser (CORS) requests, and is free to use. Record the
  exact URL pattern, a trimmed sample response with the fields the builder will
  use, any rate limit, and what the entry should show when it fails. If you
  can't confirm an endpoint, don't use it.
- Revenue: briefly check whether people already pay for something like this,
  and what for.

**Then challenge your pick.** Before writing the spec, argue against your top
choice in two or three sentences as the reviewer would. If the argument wins,
take the runner-up.

## Output

Return exactly this block. The builder will follow it and may only cut scope,
never change the idea.

```
GENRE: one or two words
TITLE: short, specific, not cute for its own sake
PITCH: two sentences
WHY IT EXISTS: one sentence, the point of view
TASTE: one line on how it will look and feel distinctive, plus
  PALETTE: 3 to 5 hex colors with roles (background, ink, accent, ...)
  TYPE: system font stack and the largest and smallest sizes at phone width
  MOTION: how things move, and what changes in reduced-motion mode
  SOUND: none, or what and why, and that it's muted by the template's button
EMPATHY: one line, plus
  WHO IT'S FOR: the person, the situation they're in when they open it, and what
    is different for them afterwards
  FIRST SCREEN: the exact words a newcomer sees, one line of instruction at most
  FIRST 30 SECONDS: what they do and what satisfying thing happens
  FAILURE AND RECOVERY: what can go wrong and how they get back
PRINCIPLED: one line, plus any facts the entry states, each with a source
RESEARCH:
  NEEDS: the two or three findings from round 1 that led to this pick, with links
  PRIOR ART: what exists and how this differs, with links
  DATA: for each endpoint, the URL pattern, a trimmed sample response, the
    fields used, CORS confirmed yes/no, rate limit, and the offline message; or
    "none"
  WEB ACCESS: yes, or no and what that limited
CORE MECHANIC: what the person does, what the system does in response, in
  plain steps
ENDING: how a session ends, resets or is saved
BUILD SMALL: the minimum version that is still complete and good
CUT LIST: features the builder must not add
RISKS: the two things most likely to go wrong in the build, and how to avoid them
REVENUE PATH: one or two sentences, or "none"
SCORES: principled N, taste N, empathy N, originality N, buildability N, revenue N
RUNNER-UP: title and one-line pitch, and why it lost
CANDIDATES CONSIDERED: one line each for the rest, with the reason each was cut
  or lost
```
