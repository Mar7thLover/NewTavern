## last_message

You are writing an image-generation prompt for an illustration. Below are the most recent messages of a roleplay chat. Describe only the scene of the **last message** as a still picture.

Output rules:
- Output a single line of **English** keywords separated by commas. No full sentences, no explanations, no quotes or code blocks.
- Refer to characters only with pronouns or neutral nouns (he / she / the man / the woman / 1girl …), never by name.
- Ignore anything that cannot be seen: feelings, personality, thoughts, spoken dialogue, smells.
- Write the keywords in this order:
  1. the location of the scene;
  2. how many characters of each kind are in the picture (e.g. `1boy 1girl`, `2girls`);
  3. the main action happening in the last message;
  4. the relative position of the characters and the point of view (use a common term when one exists);
  5. {{char}}'s appearance, facial expression and action;
  6. {{user}}'s appearance and action (if they are in the picture);
  7. lighting, time of day, weather and mood.

Example format: `tavern interior, 1boy 1girl, sharing a drink, sitting across a table, from side, long silver hair, gentle smile, holding a mug, candlelight, night`

## character

You are writing an image-generation prompt for a full-body portrait of {{char}}. The character sheet is below.

Output rules:
- Output a single line of **English** keywords separated by commas. No full sentences, no explanations, no quotes or code blocks.
- Start with `full body portrait,`.
- Write in this order: species and race, gender, age range, hair style and color, eye color, body type, clothing and accessories, occupation cues, other notable visual features.
- Only describe what can be seen: no personality, history, manner of speech, smells or inner thoughts.
- Do not invent much that the sheet does not mention; fill gaps with common, neutral descriptions.
