//! The narrow DOCX seam Flow needs.
//!
//! CardMirror's full converter handles every Word formatting detail. Flow does
//! not need that document model: it needs the same semantic spine the converter
//! produces for a speech/backfile — Pocket, Hat, Block, Tag, Analytic, and the
//! evidence text under a Tag. Reading those named styles directly keeps a DOCX
//! import equivalent to converting it to `.cmir` first without writing a
//! second file to disk.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};
use zip::ZipArchive;

use crate::cmir::Section;
use serde_json::{json, Value};

const MAX_XML_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq)]
enum ParagraphKind {
    Pocket,
    Hat,
    Block,
    Tag,
    Analytic,
    Body,
}

struct Paragraph {
    kind: ParagraphKind,
    text: String,
}

fn part(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String, String> {
    let file = archive
        .by_name(name)
        .map_err(|_| format!("docx is missing {name}"))?;
    if file.size() > MAX_XML_BYTES as u64 {
        return Err(format!("{name} is larger than this will read"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_XML_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read {name}: {e}"))?;
    if bytes.len() > MAX_XML_BYTES {
        return Err(format!("{name} is larger than this will read"));
    }
    String::from_utf8(bytes).map_err(|e| format!("{name} is not UTF-8 XML: {e}"))
}

fn local(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn attribute(
    event: &quick_xml::events::BytesStart<'_>,
    key: &[u8],
    reader: &Reader<&[u8]>,
) -> Option<String> {
    event.attributes().flatten().find_map(|attribute| {
        (local(attribute.key.as_ref()) == key)
            .then(|| {
                attribute
                    .decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
                    .ok()
                    .map(|v| v.into_owned())
            })
            .flatten()
    })
}

fn styles(xml: &str) -> Result<HashMap<String, String>, String> {
    let mut reader = Reader::from_str(xml);
    let mut current: Option<String> = None;
    let mut out = HashMap::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if local(event.name().as_ref()) == b"style" => {
                current = attribute(&event, b"styleId", &reader);
            }
            Ok(Event::Empty(event)) if local(event.name().as_ref()) == b"name" => {
                if let (Some(id), Some(name)) =
                    (current.as_ref(), attribute(&event, b"val", &reader))
                {
                    out.insert(id.clone(), name);
                }
            }
            Ok(Event::End(event)) if local(event.name().as_ref()) == b"style" => current = None,
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("cannot read word/styles.xml: {error}")),
            _ => {}
        }
    }
    Ok(out)
}

fn classify(style_id: &str, names: &HashMap<String, String>) -> ParagraphKind {
    let name = names.get(style_id).map(String::as_str).unwrap_or(style_id);
    let normalized: String = name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    match normalized.as_str() {
        "heading1" => ParagraphKind::Pocket,
        "heading2" => ParagraphKind::Hat,
        "heading3" => ParagraphKind::Block,
        "heading4" | "tag" => ParagraphKind::Tag,
        "analytics" | "analytic" => ParagraphKind::Analytic,
        _ => ParagraphKind::Body,
    }
}

fn paragraphs(xml: &str, names: &HashMap<String, String>) -> Result<Vec<Paragraph>, String> {
    let mut reader = Reader::from_str(xml);
    let mut in_paragraph = false;
    let mut in_text = false;
    let mut style = String::new();
    let mut value = String::new();
    let mut out = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) if local(event.name().as_ref()) == b"p" => {
                in_paragraph = true;
                style.clear();
                value.clear();
            }
            Ok(Event::Empty(event))
                if in_paragraph && local(event.name().as_ref()) == b"pStyle" =>
            {
                style = attribute(&event, b"val", &reader).unwrap_or_default();
            }
            Ok(Event::Start(event)) if in_paragraph && local(event.name().as_ref()) == b"t" => {
                in_text = true
            }
            Ok(Event::Text(event)) if in_text => {
                value.push_str(
                    &event
                        .decode()
                        .map_err(|e| format!("cannot decode document text: {e}"))?,
                );
            }
            Ok(Event::Empty(event))
                if in_paragraph && matches!(local(event.name().as_ref()), b"tab" | b"br") =>
            {
                value.push(' ')
            }
            Ok(Event::End(event)) if local(event.name().as_ref()) == b"t" => in_text = false,
            Ok(Event::End(event)) if local(event.name().as_ref()) == b"p" => {
                in_paragraph = false;
                let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
                if !text.is_empty() {
                    out.push(Paragraph {
                        kind: classify(&style, names),
                        text,
                    });
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("cannot read word/document.xml: {error}")),
            _ => {}
        }
    }
    Ok(out)
}

fn finish_item(
    open: Option<usize>,
    item: &mut Option<(String, String, Vec<String>)>,
    sections: &mut [Section],
) {
    let (Some(at), Some((support, head, body))) = (open, item.take()) else {
        return;
    };
    sections[at].answers.push(head.clone());
    sections[at].support.push(support.clone());
    let mut all = vec![head.clone()];
    all.extend(body.iter().cloned());
    sections[at].context.push(all.join("\n"));
    let native: Value = if support == "card" {
        let mut content = vec![
            json!({ "type": "tag", "content": [{ "type": "text", "text": head }] }),
        ];
        content.extend(body.into_iter().map(|line|
            json!({ "type": "card_body", "content": [{ "type": "text", "text": line }] })
        ));
        json!({
            "type": "card",
            "attrs": { "numRole": "none", "numRestart": false },
            "content": content
        })
    } else {
        json!({
            "type": "analytic_unit",
            "attrs": { "numRole": "none", "numRestart": false },
            "content": [{ "type": "analytic", "content": [{ "type": "text", "text": head }] }]
        })
    };
    sections[at].native.push(native);
}

fn assemble(paragraphs: Vec<Paragraph>) -> Vec<Section> {
    let mut pocket = String::new();
    let mut hat = String::new();
    let mut sections = Vec::new();
    let mut open = None;
    let mut item: Option<(String, String, Vec<String>)> = None;
    for paragraph in paragraphs {
        match paragraph.kind {
            ParagraphKind::Pocket => {
                finish_item(open, &mut item, &mut sections);
                pocket = paragraph.text;
                hat.clear();
                open = None;
            }
            ParagraphKind::Hat => {
                finish_item(open, &mut item, &mut sections);
                hat = paragraph.text;
                open = None;
            }
            ParagraphKind::Block => {
                finish_item(open, &mut item, &mut sections);
                sections.push(Section {
                    position: if hat.is_empty() {
                        pocket.clone()
                    } else {
                        hat.clone()
                    },
                    argument: paragraph.text,
                    answers: Vec::new(),
                    context: Vec::new(),
                    support: Vec::new(),
                    native: Vec::new(),
                });
                open = Some(sections.len() - 1);
            }
            ParagraphKind::Tag | ParagraphKind::Analytic => {
                finish_item(open, &mut item, &mut sections);
                item = Some((
                    if paragraph.kind == ParagraphKind::Tag {
                        "card"
                    } else {
                        "analytic"
                    }
                    .into(),
                    paragraph.text,
                    Vec::new(),
                ));
            }
            ParagraphKind::Body => {
                if let Some((_, _, body)) = item.as_mut() {
                    body.push(paragraph.text);
                }
            }
        }
    }
    finish_item(open, &mut item, &mut sections);
    sections.retain(|section| !section.answers.is_empty());
    sections
}

/// Convert DOCX bytes into the same sections the native `.cmir` reader emits.
pub fn sections(bytes: &[u8]) -> Result<Vec<Section>, String> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a Word document: {e}"))?;
    let style_xml = part(&mut archive, "word/styles.xml")?;
    let document_xml = part(&mut archive, "word/document.xml")?;
    let names = styles(&style_xml)?;
    Ok(assemble(paragraphs(&document_xml, &names)?))
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use super::{assemble, sections, styles, Paragraph, ParagraphKind};

    fn p(kind: ParagraphKind, text: &str) -> Paragraph {
        Paragraph {
            kind,
            text: text.into(),
        }
    }

    #[test]
    fn named_styles_resolve_to_their_word_ids() {
        let xml = r#"<w:styles xmlns:w="x">
          <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/></w:style>
          <w:style w:type="paragraph" w:styleId="Analytics"><w:name w:val="Analytics"/></w:style>
        </w:styles>"#;
        let read = styles(xml).unwrap();
        assert_eq!(read["Heading3"], "heading 3");
        assert_eq!(read["Analytics"], "Analytics");
    }

    #[test]
    fn word_structure_becomes_cardmirror_sections_with_full_context() {
        let read = assemble(vec![
            p(ParagraphKind::Pocket, "Off"),
            p(ParagraphKind::Hat, "OFF"),
            p(ParagraphKind::Block, "Politics---1NC"),
            p(ParagraphKind::Tag, "Election close now"),
            p(ParagraphKind::Body, "Smith 26"),
            p(ParagraphKind::Body, "The full evidence text."),
            p(ParagraphKind::Analytic, "Their evidence predates the link"),
        ]);

        assert_eq!(read.len(), 1);
        assert_eq!(read[0].argument, "Politics---1NC");
        assert_eq!(
            read[0].answers,
            ["Election close now", "Their evidence predates the link"]
        );
        assert_eq!(read[0].support, ["card", "analytic"]);
        assert!(read[0].context[0].contains("The full evidence text."));
        assert_eq!(read[0].context[1], "Their evidence predates the link");
    }

    #[test]
    fn reads_the_semantic_spine_from_a_docx_archive() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("word/styles.xml", options).unwrap();
        writer
            .write_all(
                br#"<w:styles xmlns:w="x">
                  <w:style w:styleId="Heading3"><w:name w:val="heading 3"/></w:style>
                  <w:style w:styleId="Heading4"><w:name w:val="heading 4"/></w:style>
                </w:styles>"#,
            )
            .unwrap();
        writer.start_file("word/document.xml", options).unwrap();
        writer
            .write_all(
                br#"<w:document xmlns:w="x"><w:body>
                  <w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Gulf---1AC</w:t></w:r></w:p>
                  <w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Deterrence solves</w:t></w:r></w:p>
                  <w:p><w:r><w:t>Full evidence.</w:t></w:r></w:p>
                </w:body></w:document>"#,
            )
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();

        let read = sections(&bytes).unwrap();
        assert_eq!(read[0].argument, "Gulf---1AC");
        assert_eq!(read[0].answers, ["Deterrence solves"]);
        assert!(read[0].context[0].contains("Full evidence."));
    }
}
