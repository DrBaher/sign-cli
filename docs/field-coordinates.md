# Field placement & the coordinate contract

`--field` (on `request create` and `request run-email`) places a signature,
initials, date, or text box at an explicit spot on a document. This page is the
contract for what those coordinates mean — per provider — because the values are
passed through to the provider largely untransformed, and getting the origin
wrong lands a signature in the middle of your body text.

## The `--field` grammar

```
--field signer:N,doc:N,page:N,x:N,y:N[,type:T][,width:N][,height:N][,required:true|false]
```

| Key        | Meaning                                                                 | Indexing |
|------------|-------------------------------------------------------------------------|----------|
| `signer`   | Which signer fills the field. Matches the `order:N` on `--signer`.      | **1-based** |
| `doc`      | Which document (when you pass multiple `--document`).                    | **0-based** |
| `page`     | Page within that document.                                              | **1-based** |
| `x`, `y`   | Top-left corner of the field box, in provider units (see below).        | —        |
| `type`     | `signature` (default) \| `initials` \| `date` \| `text` \| `name` \| `email`. | — |
| `width`    | Field box width. Optional; providers apply a default if omitted.        | —        |
| `height`   | Field box height. Optional; providers apply a default if omitted.       | —        |
| `required` | `true` (default) or `false`.                                            | —        |

> The mixed indexing is historical: `doc` is a 0-based array index, while `page`
> and `signer` mirror the 1-based numbers a human reads off the page and the
> `--signer order:N`. If you pass `doc:1` with a single document you'll get
> `Field doc:1 is out of range`.

Anchor / text-tag placement (`anchor:"Sign here"`) is **not** supported through
this CLI for any provider — you must supply explicit `page` + `x` + `y`.

## The origin: top-left, every provider

All three remote providers this CLI targets place fields from the **top-left
corner of the page**, with `x` increasing rightward and `y` increasing
**downward**:

| Provider      | Origin    | `x`/`y` refer to        | Units                                   |
|---------------|-----------|-------------------------|-----------------------------------------|
| SignWell      | top-left  | top-left of the field   | page pixels (top-left origin)           |
| Dropbox Sign  | top-left  | top-left of the field   | pixels from the top-left of the page    |
| DocuSign      | top-left  | top-left of the tab     | pixels (`xPosition`/`yPosition`)        |

So `--field ...,x:72,y:50` is "72 across, 50 down from the top-left corner".

## The trap: bottom-left detectors

PDF user space — and most pdfjs-based "find the signature line" detectors — use a
**bottom-left** origin, where `y` increases **upward**. If you feed those numbers
straight into `--field`, the field is mirrored vertically and lands in the wrong
place (often in the body text near the top).

Convert before you place. The flip is:

```
y_top_left = pageHeight - y_bottom_left - fieldHeight
```

This CLI ships that conversion so you don't hand-roll it:

```ts
import { bottomLeftToTopLeft } from "sign-cli/dist/lib/field-placement.js";

// pageHeight and y in the same units (e.g. PDF points; US Letter = 792pt tall)
const { x, y } = bottomLeftToTopLeft({ x: 72, y: 100, pageHeight: 792, height: 30 });
// → { x: 72, y: 662 }   ready for --field x:72,y:662,height:30
```

Pass `height` so the box's top edge lands where you expect; omit it and you get
the baseline point flipped (the field's top edge sits on the detected line and
the box extends downward).

### Units / DPI

`x`, `y`, `width`, `height` must all be in the **same** unit as the page
dimension you used for the conversion. If your detector reports PDF points
(72 per inch), keep everything in points. If it reports pixels rendered at some
DPI, convert the page height to that same pixel space first. Mixing points and
rendered pixels is the most common way to be "close but off by a scale factor".

## Quick checklist

- [ ] `signer` matches a `--signer order:N` (1-based).
- [ ] `doc` is 0-based; a single document is always `doc:0`.
- [ ] `x`/`y` are top-left origin, `y` increasing downward.
- [ ] If your coordinates came from a pdfjs/bottom-left detector, run them
      through `bottomLeftToTopLeft` first.
- [ ] `x`/`y`/`width`/`height` are all in the same unit.
