export default {
  name: 'weave-config',
  scopeName: 'source.weave',
  patterns: [
    { include: '#comment' },
    { include: '#tripleString' },
    { include: '#string' },
    { include: '#blockDeclaration' },
    { include: '#keywords' },
    { include: '#constants' },
    { include: '#number' },
    { include: '#punctuation' },
  ],
  repository: {
    comment: {
      patterns: [
        {
          name: 'comment.line.number-sign.weave',
          match: '#.*$',
        },
      ],
    },
    tripleString: {
      patterns: [
        {
          name: 'string.quoted.multi.weave',
          begin: '"""',
          end: '"""',
        },
      ],
    },
    string: {
      patterns: [
        {
          name: 'string.quoted.double.weave',
          begin: '"',
          end: '"',
          patterns: [
            {
              name: 'constant.character.escape.weave',
              match: '\\\\.',
            },
          ],
        },
      ],
    },
    blockDeclaration: {
      patterns: [
        {
          match:
            '\\b(agent|category|workflow|step)\\b\\s+([A-Za-z_][A-Za-z0-9_-]*)',
          captures: {
            1: { name: 'keyword.control.declaration.weave' },
            2: { name: 'entity.name.type.weave' },
          },
        },
      ],
    },
    keywords: {
      patterns: [
        {
          name: 'keyword.control.weave',
          match:
            '\\b(description|prompt|prompt_file|prompt_append|prompt_append_file|models|mode|temperature|skills|triggers|routing|delegation_exclude|tool_policy|patterns|version|name|type|agent|completion|inputs|outputs|on_reject|extension_points|role|disable|settings|runtime|journal|strict|extend|before-plan)\\b',
        },
      ],
    },
    constants: {
      patterns: [
        {
          name: 'constant.language.weave',
          match:
            '\\b(allow|deny|ask|primary|subagent|all|autonomous|interactive|gate|planning|agent_signal|user_confirm|plan_created|plan_complete|review_verdict|pause|INFO|DEBUG|WARN|ERROR|true|false)\\b',
        },
      ],
    },
    number: {
      patterns: [
        {
          name: 'constant.numeric.weave',
          match: '\\b\\d+(?:\\.\\d+)?\\b',
        },
      ],
    },
    punctuation: {
      patterns: [
        {
          name: 'punctuation.definition.array.begin.weave',
          match: '\\[',
        },
        {
          name: 'punctuation.definition.array.end.weave',
          match: '\\]',
        },
        {
          name: 'punctuation.definition.block.begin.weave',
          match: '\\{',
        },
        {
          name: 'punctuation.definition.block.end.weave',
          match: '\\}',
        },
      ],
    },
  },
};
