---
name: ui-qa-audit
description: Audit an application's visual design, usability, layout, interactions, and motion using the tools available in the current environment. Use for requested UI or UX audits of web or desktop applications.
---

# UI visual QA audit

Find and clearly report UI issues; do not change application code or publish findings unless requested. No particular automation framework, plugin, operating system, or companion skill is required. Use the current environment's available browser, desktop automation, screenshot, and image inspection tools. Respect its tool and permission rules. If a required capability is missing, continue with what is available and state what could not be checked.

## Understand and cover the application

Discover the screen's purpose, expected behavior, and design conventions from the running app, related screens, user instructions, and relevant project documentation or code. Compare equivalent controls and states; don't assume an unfamiliar design is wrong or intentionally correct. If intent is unknown, report the visual concern and uncertainty.

Map relevant views and flows before claiming broad coverage: first run, empty and populated data, primary actions, settings and dialogs, loading and error states, keyboard access, supported window sizes, and platform-specific surfaces. Use isolated test data where practical. Interact only within the user's authorized scope. Record untested areas; a complete audit is not established by a smoke test.

## Inspect visually

Start each settled view with the full unaltered screenshot at ordinary scale. Judge the screen as a user would: what looks awkward, confusing, inconsistent, or unfinished? Inspect layout, grouping, hierarchy, spacing, alignment, readability, control affordances, clipping, overlays, and visual consistency. Explain what is actually visible and why it matters; a screenshot that loads successfully or passes automated checks can still look wrong.

Then perform a second visual pass over the entire screenshot in overlapping regions, including sidebars and narrow margins. Divide the original screenshot into roughly three overlapping vertical slices or into meaningful UI panes; inspect every slice at a readable, enlarged scale, with coordinates mapped back to the full view. Do this even when the first impression looks clean. Actually enlarge each slice for viewing, not just crop it at its original size; aim for approximately 2–3 times its original dimensions while keeping the whole slice visible in the image viewer. Inspect a contrast-adjusted version of dark or low-contrast slices as well when the tools allow, then compare any candidate with the unaltered original. Use saved screenshots and available local image tools if the capture tool cannot enlarge or adjust contrast. When Python and Pillow are available, the optional helper scripts/inspect_views.py takes an original screenshot and a new output directory, then prepares three overlapping 2× slices and dark-detail aids with a coordinate manifest; inspect all returned views, not only the manifest. Use an equivalent image tool if the helper cannot run. For each region describe and judge control-to-label relationships, nested content, separators, borders, and repeated visual marks; compare similar components when available. For each visible tree or nested list, inspect the guide marks at each indentation level: describe how many separate guides are visible and which hierarchy each appears to represent. Flag confusing or seemingly redundant guides as a design concern only when the original image supports it; multiple guides may be intentional. Don't merely inventory elements: assess whether their presentation is clear and consistent. Preserve original-resolution captures and distinguish enhancement artifacts from defects. Report which enlarged and contrast-adjusted views were actually inspected; if a capability is unavailable, state that limitation. Screenshots and slices are evidence to visually inspect, not merely tool outputs to count.

Observe motion and interactions over time where the environment permits. Capture before and after states and wait for an appropriate settled state; an element existing in a document tree doesn't prove it is visible or unobscured. Check keyboard focus in and out of dialogs and test supported viewport boundaries where relevant. Do not infer animation smoothness or functional behavior from a static image.

Treat automated measurements as leads. Examine their definitions and context before reporting a defect: hidden accessibility text, editor widgets, intended ellipses, and offscreen elements can produce false positives. Verify suspected overlap, contrast, performance, and interaction issues with suitable tools if available; otherwise identify them as unconfirmed.

## Report

Give a prioritized list of findings. For each, include the affected screen and environment, preconditions, reproducible steps when available, expected and actual behavior or appearance, impact, and direct screenshot or other evidence. Distinguish reproducible defects from subjective design suggestions and uncertain intent. Describe what was actually tested, what remains untested, and any missing capabilities or measurement limitations. Incorporate user corrections and check related areas for the same class of issue. Never promise that the audit finds every issue.

## Pseudoharness audits

When the target is this repository, read [the Pseudoharness audit map](references/pseudoharness.md) before testing. It lists the actual workspace destinations, important overlays, and the hidden QA-MCP convention. Keep the general evidence and visual-inspection rules above in force.
