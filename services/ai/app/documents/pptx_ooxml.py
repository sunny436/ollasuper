"""Clean-room raw-OOXML PowerPoint surgery — the faithful operations python-pptx cannot
do: duplicate an EXISTING slide (with its shapes/formatting), merge decks, remove orphan
parts, integrity-validate, and normalise a .potx template to an editable .pptx.

Adapted from the METHODOLOGY of Anthropic's `add_slide.py` / `clean.py` (no source code
copied): copy the slide part + its rels, allocate fresh rId/slideId, register in
[Content_Types].xml + presentation.xml(.rels) + the sldIdLst, strip notes from the copy,
and warn that a duplicate SHARES the source's chart/media parts (editing one changes the
other). XML is parsed with a hardened, entity-resolution-disabled lxml parser (XXE-safe)
because the input is UNTRUSTED. Every function raises `DocumentError` on a controlled
failure; the executor re-opens + validates the output before delivering it.
"""

from __future__ import annotations

import io
import re
import zipfile

from app.documents.pdf_ops import DocumentError

_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
_SLIDE_CT = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
_SLIDE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
_NOTES_REL = "notesSlide"
_SLIDE_RE = re.compile(r"^ppt/slides/slide(\d+)\.xml$")


def _parser():
    from lxml import etree

    return etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False)


def _load(raw: bytes) -> dict[str, bytes]:
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            if "ppt/presentation.xml" not in z.namelist():
                raise DocumentError("not a PowerPoint package.")
            return {n: z.read(n) for n in z.namelist()}
    except zipfile.BadZipFile as e:
        raise DocumentError("could not open the presentation (corrupt file).") from e


def _pack(parts: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        # [Content_Types].xml first is conventional and required by some readers.
        if "[Content_Types].xml" in parts:
            z.writestr("[Content_Types].xml", parts["[Content_Types].xml"])
        for name, data in parts.items():
            if name == "[Content_Types].xml":
                continue
            z.writestr(name, data)
    return buf.getvalue()


def _slide_rels_name(slide_part: str) -> str:
    base = slide_part.rsplit("/", 1)[-1]
    return f"ppt/slides/_rels/{base}.rels"


def _next_slide_num(parts: dict[str, bytes]) -> int:
    nums = [int(m.group(1)) for n in parts if (m := _SLIDE_RE.match(n))]
    return (max(nums) + 1) if nums else 1


def _next_rid(rels_root) -> str:
    used = {r.get("Id") for r in rels_root}
    i = 1
    while f"rId{i}" in used:
        i += 1
    return f"rId{i}"


def duplicate_slide(
    raw: bytes, index: int, after: int | None = None
) -> tuple[bytes, list[str]]:
    """Duplicate the 1-based `index` slide, inserting the copy after `after` (default:
    right after the source). Returns (bytes, warnings). The copy SHARES the source's
    chart/diagram/media parts (a warning names them), mirroring the source tool."""
    from lxml import etree

    parts = _load(raw)
    parser = _parser()
    pres = etree.fromstring(parts["ppt/presentation.xml"], parser)
    prels = etree.fromstring(parts["ppt/_rels/presentation.xml.rels"], parser)

    lst = pres.find(f"{{{_P}}}sldIdLst")
    if lst is None:
        raise DocumentError("the presentation has no slide list.")
    sldIds = list(lst)
    n = len(sldIds)
    if index < 1 or index > n:
        raise DocumentError(f"slide {index} is out of range (1-{n}).")

    rid_to_target = {r.get("Id"): r.get("Target") for r in prels}
    src_rid = sldIds[index - 1].get(f"{{{_R}}}id")
    src_target = rid_to_target.get(src_rid)
    if not src_target:
        raise DocumentError("could not resolve the source slide.")
    src_part = (
        "ppt/" + src_target.lstrip("/")
        if not src_target.startswith("ppt/")
        else src_target
    )
    if src_part not in parts:
        # Targets in presentation.xml.rels are relative to ppt/.
        src_part = "ppt/" + src_target.lstrip("/")
    if src_part not in parts:
        raise DocumentError("the source slide part is missing.")

    new_num = _next_slide_num(parts)
    new_part = f"ppt/slides/slide{new_num}.xml"
    new_target = f"slides/slide{new_num}.xml"

    # 1) copy the slide XML verbatim
    parts[new_part] = parts[src_part]

    # 2) copy its rels, stripping notesSlide refs; note shared chart/media parts
    warnings: list[str] = []
    src_rels = _slide_rels_name(src_part)
    if src_rels in parts:
        rels_root = etree.fromstring(parts[src_rels], parser)
        for rel in list(rels_root):
            rtype = rel.get("Type", "")
            if rtype.endswith(_NOTES_REL):
                rels_root.remove(rel)
                continue
            tgt = rel.get("Target", "")
            if any(k in tgt for k in ("charts/", "diagrams/", "embeddings/", "media/")):
                warnings.append(tgt.rsplit("/", 1)[-1])
        parts[_slide_rels_name(new_part)] = etree.tostring(
            rels_root, xml_declaration=True, encoding="UTF-8", standalone=True
        )

    # 3) register the content-type override
    ct = etree.fromstring(parts["[Content_Types].xml"], parser)
    part_name = "/" + new_part
    if not any(
        o.get("PartName") == part_name for o in ct.findall(f"{{{_CT}}}Override")
    ):
        ov = etree.SubElement(ct, f"{{{_CT}}}Override")
        ov.set("PartName", part_name)
        ov.set("ContentType", _SLIDE_CT)
    parts["[Content_Types].xml"] = etree.tostring(
        ct, xml_declaration=True, encoding="UTF-8", standalone=True
    )

    # 4) add a presentation.xml.rels relationship with a fresh rId
    new_rid = _next_rid(prels)
    rel = etree.SubElement(prels, f"{{{_RELS}}}Relationship")
    rel.set("Id", new_rid)
    rel.set("Type", _SLIDE_REL)
    rel.set("Target", new_target)
    parts["ppt/_rels/presentation.xml.rels"] = etree.tostring(
        prels, xml_declaration=True, encoding="UTF-8", standalone=True
    )

    # 5) insert a sldId with a fresh id, after `after` (default = after the source)
    ids = [int(s.get("id")) for s in sldIds if s.get("id")]
    new_id = max(ids) + 1 if ids else 256
    if new_id >= 2**31:
        raise DocumentError("slide id space exhausted.")
    new_sldId = etree.SubElement(lst, f"{{{_P}}}sldId")
    new_sldId.set("id", str(new_id))
    new_sldId.set(f"{{{_R}}}id", new_rid)
    pos = index if after is None else max(0, min(int(after), n))
    lst.remove(new_sldId)
    lst.insert(pos, new_sldId)
    parts["ppt/presentation.xml"] = etree.tostring(
        pres, xml_declaration=True, encoding="UTF-8", standalone=True
    )

    out = _pack(parts)
    warn_msgs: list[str] = []
    if warnings:
        warn_msgs.append(
            "the duplicated slide shares these parts with the original "
            f"(editing one affects the other): {', '.join(sorted(set(warnings)))}"
        )
    return out, warn_msgs


def normalize_to_pptx(raw: bytes) -> bytes:
    """Rewrite a .potx template's content type so the output opens as an editable "
    ".pptx."""
    from lxml import etree

    parts = _load(raw)
    ct = etree.fromstring(parts["[Content_Types].xml"], _parser())
    tmpl = (
        "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml"
    )
    pres = (
        "application/vnd.openxmlformats-officedocument"
        ".presentationml.presentation.main+xml"
    )
    changed = False
    for o in ct.findall(f"{{{_CT}}}Override"):
        if o.get("ContentType") == tmpl:
            o.set("ContentType", pres)
            changed = True
    if not changed:
        return raw
    parts["[Content_Types].xml"] = etree.tostring(
        ct, xml_declaration=True, encoding="UTF-8", standalone=True
    )
    return _pack(parts)


def integrity(raw: bytes) -> dict:
    """Reference-integrity validation (the practical substitute for full XSD): every
    part parses, every .rels Target exists, sldIdLst rIds resolve to slide parts, slide
    content-type overrides are present, and slide ids are unique. Returns {ok,
    problems}.
    """
    from lxml import etree

    problems: list[str] = []
    try:
        parts = _load(raw)
    except DocumentError as e:
        return {"ok": False, "problems": [str(e)]}
    parser = _parser()

    for name, data in parts.items():
        if name.endswith(".xml") or name.endswith(".rels"):
            try:
                etree.fromstring(data, parser)
            except Exception:  # noqa: BLE001
                problems.append(f"{name}: not well-formed XML")

    # rels targets resolve
    for name, data in parts.items():
        if not name.endswith(".rels"):
            continue
        # The part directory is everything before "_rels/"; the root rels
        # (_rels/.rels) resolves its targets from the package root ("").
        base_dir = name.rsplit("_rels/", 1)[0].rstrip("/")
        try:
            root = etree.fromstring(data, parser)
        except Exception:  # noqa: BLE001,S112
            continue
        for rel in root:
            if rel.get("TargetMode") == "External":
                continue
            tgt = rel.get("Target", "")
            resolved = _resolve(base_dir, tgt)
            if resolved and resolved not in parts:
                problems.append(f"{name}: dangling relationship -> {tgt}")

    # sldIdLst rIds resolve to slide parts + unique ids
    try:
        pres = etree.fromstring(parts["ppt/presentation.xml"], parser)
        prels = etree.fromstring(parts["ppt/_rels/presentation.xml.rels"], parser)
        rid_to_target = {r.get("Id"): r.get("Target") for r in prels}
        lst = pres.find(f"{{{_P}}}sldIdLst")
        seen_ids: set[str] = set()
        for s in lst if lst is not None else []:
            sid = s.get("id")
            if sid in seen_ids:
                problems.append(f"duplicate slide id {sid}")
            seen_ids.add(sid)
            rid = s.get(f"{{{_R}}}id")
            tgt = rid_to_target.get(rid)
            part = "ppt/" + (tgt or "").lstrip("/")
            if not tgt or part not in parts:
                problems.append(f"sldId {sid}: unresolved slide rId {rid}")
            elif not any(
                o.get("PartName") == "/" + part
                for o in etree.fromstring(parts["[Content_Types].xml"], parser).findall(
                    f"{{{_CT}}}Override"
                )
            ):
                problems.append(f"{part}: missing content-type override")
    except Exception as e:  # noqa: BLE001
        problems.append(f"presentation structure unreadable: {type(e).__name__}")

    return {"ok": not problems, "problems": problems[:50]}


def _resolve(base_dir: str, target: str) -> str | None:
    if not target or target.startswith(("http://", "https://", "/")):
        return target.lstrip("/") if target.startswith("/") else None
    parts = (base_dir + "/" + target).split("/")
    stack: list[str] = []
    for p in parts:
        if p == "..":
            if stack:
                stack.pop()
        elif p not in ("", "."):
            stack.append(p)
    return "/".join(stack)


def _content_type_for(parts: dict[str, bytes], part: str, parser) -> str | None:
    """The Override content-type for an xml part, if declared."""
    from lxml import etree

    try:
        ct = etree.fromstring(parts["[Content_Types].xml"], parser)
    except Exception:  # noqa: BLE001
        return None
    for o in ct.findall(f"{{{_CT}}}Override"):
        if (o.get("PartName") or "").lstrip("/") == part:
            return o.get("ContentType")
    return None


def merge_pptx(files: list[bytes]) -> tuple[bytes, list[str]]:
    """Combine decks into the FIRST deck (editable), importing each later deck's slides
    with their full rels closure (media/charts/embeddings) renamed to avoid collisions,
    and re-pointing each imported slide's layout to the target's first layout (so the
    master/theme graph is not duplicated). Imported slides adopt the target deck's
    theme;
    this is an EXTENSION beyond the source skill and is validated before delivery."""
    from lxml import etree

    if len(files) < 2:
        raise DocumentError("provide at least two presentations to merge.")
    parser = _parser()
    tgt = _load(files[0])
    tpres = etree.fromstring(tgt["ppt/presentation.xml"], parser)
    tprels = etree.fromstring(tgt["ppt/_rels/presentation.xml.rels"], parser)
    tlst = tpres.find(f"{{{_P}}}sldIdLst")
    if tlst is None:
        raise DocumentError("the base presentation has no slide list.")
    tct = etree.fromstring(tgt["[Content_Types].xml"], parser)
    # a target layout to re-point imported slides at
    tgt_layouts = sorted(
        n for n in tgt if re.match(r"ppt/slideLayouts/slideLayout\d+\.xml$", n)
    )
    if not tgt_layouts:
        raise DocumentError("the base presentation has no slide layout.")
    tgt_layout = tgt_layouts[0]

    ids = [int(s.get("id")) for s in tlst if s.get("id")]
    next_id = (max(ids) + 1) if ids else 256
    warnings: list[str] = []
    counter = {"m": 0}

    for raw in files[1:]:
        src = _load(raw)
        spres = etree.fromstring(src["ppt/presentation.xml"], parser)
        sprels = etree.fromstring(src["ppt/_rels/presentation.xml.rels"], parser)
        rid_to_target = {r.get("Id"): r.get("Target") for r in sprels}
        slst = spres.find(f"{{{_P}}}sldIdLst")
        for s in slst if slst is not None else []:
            tgt_rel = rid_to_target.get(s.get(f"{{{_R}}}id"))
            src_slide = "ppt/" + (tgt_rel or "").lstrip("/")
            if not tgt_rel or src_slide not in src:
                continue
            new_num = _next_slide_num(tgt)
            new_part = f"ppt/slides/slide{new_num}.xml"
            tgt[new_part] = src[src_slide]
            # copy the slide's rels closure (renamed), re-point layout, drop notes
            _import_slide_rels(
                src,
                tgt,
                tct,
                src_slide,
                new_part,
                tgt_layout,
                parser,
                counter,
                warnings,
            )
            ov = etree.SubElement(tct, f"{{{_CT}}}Override")
            ov.set("PartName", "/" + new_part)
            ov.set("ContentType", _SLIDE_CT)
            new_rid = _next_rid(tprels)
            rel = etree.SubElement(tprels, f"{{{_RELS}}}Relationship")
            rel.set("Id", new_rid)
            rel.set("Type", _SLIDE_REL)
            rel.set("Target", f"slides/slide{new_num}.xml")
            sldId = etree.SubElement(tlst, f"{{{_P}}}sldId")
            sldId.set("id", str(next_id))
            sldId.set(f"{{{_R}}}id", new_rid)
            next_id += 1
            if next_id >= 2**31:
                raise DocumentError("slide id space exhausted during merge.")

    tgt["ppt/presentation.xml"] = etree.tostring(
        tpres, xml_declaration=True, encoding="UTF-8", standalone=True
    )
    tgt["ppt/_rels/presentation.xml.rels"] = etree.tostring(
        tprels, xml_declaration=True, encoding="UTF-8", standalone=True
    )
    tgt["[Content_Types].xml"] = etree.tostring(
        tct, xml_declaration=True, encoding="UTF-8", standalone=True
    )
    msg = ["imported slides adopt the base deck's theme/layout"]
    return _pack(tgt), (msg + list(dict.fromkeys(warnings)))[:5]


def _import_slide_rels(
    src, tgt, tct, src_slide, new_part, tgt_layout, parser, counter, warnings
) -> None:
    from lxml import etree

    src_rels = _slide_rels_name(src_slide)
    if src_rels not in src:
        return
    root = etree.fromstring(src[src_rels], parser)
    for rel in list(root):
        rtype = rel.get("Type", "")
        if rel.get("TargetMode") == "External":
            continue
        if rtype.endswith(_NOTES_REL):
            root.remove(rel)
            continue
        if rtype.endswith("slideLayout"):
            rel.set("Target", "../slideLayouts/" + tgt_layout.rsplit("/", 1)[-1])
            continue
        # media/chart/embedding/image → copy the referenced part (renamed) into target
        tgt_rel = rel.get("Target", "")
        src_part = _resolve(src_slide.rsplit("/", 1)[0], tgt_rel)
        if not src_part or src_part not in src:
            root.remove(rel)
            continue
        ext = src_part.rsplit(".", 1)[-1] if "." in src_part else "dat"
        folder = src_part.split("/")[1] if src_part.count("/") >= 2 else "media"
        counter["m"] += 1
        new_name = f"ppt/{folder}/merged{counter['m']}.{ext}"
        while new_name in tgt:
            counter["m"] += 1
            new_name = f"ppt/{folder}/merged{counter['m']}.{ext}"
        tgt[new_name] = src[src_part]
        rel.set("Target", "../" + folder + "/" + new_name.rsplit("/", 1)[-1])
        _ensure_content_type(src, tgt, tct, src_part, new_name, ext, parser)
        if folder in ("charts", "diagrams", "embeddings"):
            warnings.append(new_name.rsplit("/", 1)[-1])
    tgt[_slide_rels_name(new_part)] = etree.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True
    )


def _ensure_content_type(src, tgt, tct, src_part, new_name, ext, parser) -> None:
    from lxml import etree

    override = _content_type_for(src, src_part, parser)
    if override:
        ov = etree.SubElement(tct, f"{{{_CT}}}Override")
        ov.set("PartName", "/" + new_name)
        ov.set("ContentType", override)
        return
    # binary media rides a Default for its extension; ensure it exists in target
    exts = {d.get("Extension", "").lower() for d in tct.findall(f"{{{_CT}}}Default")}
    if ext.lower() not in exts:
        default_ct = {
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "gif": "image/gif",
            "emf": "image/x-emf",
            "wmf": "image/x-wmf",
            "svg": "image/svg+xml",
            "bin": "application/vnd.openxmlformats-officedocument.oleObject",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }.get(ext.lower(), "application/octet-stream")
        d = etree.SubElement(tct, f"{{{_CT}}}Default")
        d.set("Extension", ext.lower())
        d.set("ContentType", default_ct)


def cleanup(raw: bytes) -> tuple[bytes, list[str]]:
    """Remove orphan slide parts (a slideN.xml not referenced by any sldId) and their
    rels + content-type overrides. The high-value subset of the source cleaner, with a
    refuse-to-clean guard when the structure looks unreadable."""
    from lxml import etree

    parts = _load(raw)
    parser = _parser()
    try:
        pres = etree.fromstring(parts["ppt/presentation.xml"], parser)
        prels = etree.fromstring(parts["ppt/_rels/presentation.xml.rels"], parser)
    except Exception as e:  # noqa: BLE001
        raise DocumentError(
            "refusing to clean: presentation structure unreadable."
        ) from e
    rid_to_target = {r.get("Id"): r.get("Target") for r in prels}
    lst = pres.find(f"{{{_P}}}sldIdLst")
    live = set()
    for s in lst if lst is not None else []:
        tgt = rid_to_target.get(s.get(f"{{{_R}}}id"))
        if tgt:
            live.add("ppt/" + tgt.lstrip("/"))
    all_slides = {n for n in parts if _SLIDE_RE.match(n)}
    orphans = all_slides - live
    if not orphans:
        return raw, []
    if len(orphans) >= len(all_slides):
        raise DocumentError("refusing to clean: would remove every slide.")
    removed: list[str] = []
    for part in orphans:
        parts.pop(part, None)
        parts.pop(_slide_rels_name(part), None)
        removed.append(part.rsplit("/", 1)[-1])
    # drop content-type overrides for removed parts
    ct = etree.fromstring(parts["[Content_Types].xml"], parser)
    for o in list(ct.findall(f"{{{_CT}}}Override")):
        pn = (o.get("PartName") or "").lstrip("/")
        if pn in orphans:
            ct.remove(o)
    parts["[Content_Types].xml"] = etree.tostring(
        ct, xml_declaration=True, encoding="UTF-8", standalone=True
    )
    return _pack(parts), [
        f"removed {len(removed)} orphan slide(s): {', '.join(removed)}"
    ]
