import {atomic, capture, either, flags, lookAhead, maybe, sequence, suffix} from 'compose-regexp'

// function compare(x, ref) {
//     Object.entries(x).forEach(([name, rx])=>{
//         if (rx.source !== ref.source || rx.flags !== ref.flags) {
//             console.log(name)
//             console.log(rx)
//             console.log(ref)
//             throw "Bad conversion"
//         }
//     })
// }

const output = {}


output.captureMatcher = flags.add('g', either(
    ['\\', /[^]/],
    ['(?', /:|<?[=!]/],
    /[\[\](]/
))

const mStartAnchor = output.mStartAnchor = /(?:^|(?<=[\n\r\u2028\u2029]))/
const mEndAnchor = output.mEndAnchor = /(?:$|(?=[\n\r\u2028\u2029]))/

output.dotMDotSMatcher = flags.add('g', either(
    ['\\', /./],
    '.',
    mStartAnchor.source,
    mEndAnchor.source,
    '[', ']', '^', '$'
))

output.groupNameMatcher = /^[_$\p{ID_Start}][$\p{ID_Continue}]*$/u

output.loneBracketMatcher = flags.add('g', either(
    ['\\', /./],
    ['{', /\d+,?\d*/, '}'],
    capture(either('[', ']', '{', '}'))
))

output.numRefMatcher = flags.add('g', either(
    ['\\', /[^1-9]/],
    /[\[\]]/,
    ['\\', capture(suffix([1,2], /\d/))],
    ['(?:$ ^d:', capture(/\d+/), ',n:', capture(/\d+/), ')']
))

output.oneEscapeOrCharClassMatcher = sequence(
    /^/,
    either(
        ['\\', /./],
        ['[', atomic(suffix('*?', either(['\\', /./], /./))), ']']
    ),
    /$/
)

output.pEscapeMatcher = /^\\p\{[A-Za-z][A-Za-z=]*\}$/

output.stringNormalizerMatcher = /[.?*+^$[\]\\(){}|]/g

output.tokenMatcher = flags.add('g', either(
    capture('\\', /./),
    [/[-()|\[\]]/, maybe(capture(lookAhead('?', maybe('<'), /[=!]/)))]
))

const hex = /[0-9A-Fa-f]/
const u4Escape = sequence('\\u', suffix(4, hex))
const xEscape  = sequence('\\x', suffix(2, hex))
const cEscape = sequence('\\c', /[A-Za-z]/)
const badUEscapeChars = /[^.?*+^$[\]\\(){}|\/DSWdswBbfnrtv]/
const badUCharClassEscapeChars = /[^.?*+^$[\]\\(){}|\/DSWdswfnrtv-]/
const openGroupOrAssertion = sequence("(", maybe("?", /[^]/))
const closeGroupOrAssertion = sequence(
    ")", 
    maybe(either(
        /[+?*]/, 
        ['{', /\d+,?\d*/, '}']
    ))
    // no need to match the optional '?'
)
const badCharSet = either(
    /\\[DSWdsw]-[^\]]/,
    /.-\\[DSWdsw]/
)

output.uProblemCharClassMatcher = flags.add('g', either(
    u4Escape, xEscape, cEscape,
    ['\\', capture(badUCharClassEscapeChars)],
    // having badCharSet before the escape catch all lets its second alternative catch \w-\w and friends
    capture(badCharSet),
    ['\\', /./],
    ']'
))

output.uProblemDefaultMatcher = flags.add('g', either(
    u4Escape, xEscape, cEscape,
    ['\\k<', capture(/.*?/), '>'],
    ['\\', capture(badUEscapeChars)],
    ['\\', /./],
    ".", "[^]", '[',
    capture(openGroupOrAssertion),
    capture(closeGroupOrAssertion)
))

// : (x.key.multiline && match === '^'&& supportsLookBehind) ? '(?:^|(?<=[\\n\\r\\u2028\\u2029]))'
// : (x.key.multiline && match === '$' && supportsLookBehind) ? '(?:$|(?=[\\n\\r\\u2028\\u2029]))'

import fs from "fs"

const result = `//              /!\\ DO NOT EDIT MANUALLY /!\\


//   This file was generated by \`scripts/build-regexp.js\`
//   edit that file then run \`npm run build\` to regenerate it


//        /!\\ DO NOT EDIT MANUALLY /!\\

export {${Object.keys(output).sort().join(", ")}}

/*
drop this in ./core.js when changing the list:
import {${Object.keys(output).sort().join(", ")}} from './regexps.js'
*/

import {supportsU} from './utils.js'

${
    Object.entries(output).sort().map(([name, rx]) => rx.unicode ? `
var ${name} = supportsU && new RegExp(${JSON.stringify(rx.source)}, 'u')
`:`
var ${name} = ${rx}
`
    ).join('\n')
}
`
fs.writeFileSync('./src/regexps.js', result, {encoding: 'utf-8'})
