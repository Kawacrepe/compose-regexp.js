
import {allFlags, canFoldM, hasOwn, identity, map, RegExpRef, store, supportsU, unescape} from "./utils.js"

// General notes:
// 
// 1. Most functions here take an `x` parameter, which is our internal representation
// of regexps, strings, etc... it has the following structure
//
//   {
//     key: the parameter passed to the API for the first three kinds (see below), the metadata object for 'result'
//     kind : 'regexp' | 'string' | 'ref' | 'result'
//     source: the corresponding source, optionally moddified if necessary (fixing numeric refs, wrapping disjunctions in sequences...)
//   }
//
//
// 2. Stack-mamged globals are denoted by a $ prefix. Functions that mutate said globals start with a $$_ prefix.

// - - - - - - - -_-_-_-_-_-_- - - - - - - - //
//  . . .                             + + +  //
//                                           //
//    .  .      |_         |      |_         //
//    |\/| ,--. |   --. ,--|  --. |   --.    //
//    |  | |--´ |  ,--| |  | ,--| |  ,--|    //
//    '  ' `--´ `- `--´ `--´ `--´ `- `--´    //
//                                           //
//                                           //
//  + + +         _ _ _ _ _ _         . . .  //
// - - - - - - - - - - - - - - - - - - - - - //

// metadata

// static properties and matching direction info are stored here

function MetaData() {
	return {
		captureCount: null,
		direction : 0,
		hasRefs: null,
		hasFinalRef: null,
		isDisjunction: null,
		isOneGroupOrAssertion: null,
		source: null,
		unicode: null
	}
}

function findOrCreateMd(target) {
	if (target instanceof RegExpRef) {
		var md = store.get(target)
		if (md == null) store.set(target, md = MetaData())
		return md
	} else {
		return target || MetaData()
	}
}

export var metadata = {
	set: function(target, property, value) {
		var md = findOrCreateMd(target)
		return (typeof property === 'object') 
		? Object.assign(md, property)
		: md[property] = value
	},
	get: function(target, property) {
		var md = findOrCreateMd(target)
		return md[property]
	}
}

function mdMemo(property, f) {
	return Object.defineProperty(function(x) {
		var cached = metadata.get(x.key, property)
		if (cached != null) return cached
		return metadata.set(x.key, property, f(x))
	}, 'name', {value: property})
}

function getSource(x) {
	return metadata.get(x, 'source') || metadata.set(x, 'source', x.source)
}

// - - - - - - - - - - //
//- - - -     - - -    //
//                     //
//    ,      ,-        //
//    | .--. |~ .--.   //
//    | |  | |  |  |   //
//    ' '  ' '  `--´   //
//                     //
//    - - -     - - - -//
// - - - - - - - - - - //

// Functions gathering static info about regexps, mostly predicates

// combining (some of) this into a single function may give space
// and perf gains, at the expense of maintainability

var uProblemDefaultMatcher = /\\u\d{4}|\\x\d{2}|\\k<(.*?)>|\\c[A-Za-z]|\\([^.?*+^$[\]\\(){}|\/DSWdswfnrtv])|\[\^\]|\.|[\[]|(\((?:\?[^])?)|(\)(?:[+?*]|\{\d+,?\d?\})?)/g
var uProblemCharClassMatcher = /\\u\d{4}|\\x\d{2}|\\c[A-Za-z]|(\\[DSWdsw]-[^\]]|.-\\[DSWdsw])|\\([^.?*+^$[\]\\(){}|\/DSWdswfnrtv-])|[\]]/g

export var groupNameMatcher = supportsU && new RegExp('^[_$\\p{ID_Start}][$\\p{ID_Continue}]*', 'u')

// assesses if a non-unicode RegExp can be updated to unicode
// problems are invalid escapes, and quantifiers after
// a lookahead assertion
var openGroups = []
function hasUProblem(x) {
	var matcher = uProblemDefaultMatcher, result
	openGroups.length = 0
	function use(x) {
		x.lastIndex = matcher.lastIndex
		matcher = x
	}
	uProblemDefaultMatcher.lastIndex = 0
	while (result = matcher.exec(x)) {
		if (matcher === uProblemDefaultMatcher) {
		// const [
		//   match,
		// 	 namedRef,
		// 	 escapedCharacter,
		// 	 open,
		// 	 close
		// ] = result
			if (result[0] === '[') use(uProblemCharClassMatcher)
			else if (
				result[0] === '.'
				|| result[0] === '[^]'
				|| result[1] != null && !groupNameMatcher.test(unescape(result[1]))
				|| result[2] != null
			) return true

			else if (result[3] != null) {
				openGroups.unshift(result[3])
			}
			else if (result[4] != null) {
				if ((openGroups[0] === '(?=' || openGroups[0] === '(?!') && result[4] !== ')') return true
				else openGroups.shift()
			}
		} else { // matcher === uProblemCharClassMatcher
		// const [
		//   match,
		// 	 badRange,
		// 	 escapedCharacter,
		// ] = result
			if (result[0] === ']') use(uProblemDefaultMatcher)
			else if (result[1] != null || result[2] != null) return true
		}
	}
	return false
}

var captureMatcher = /\\[^]|\(\?[^<]|[\[\](]/g

var countCaptures = mdMemo('captureCount', function countCaptures(x) {
	var count = 0, inCClass = false, result
	captureMatcher.lastIndex = 0
	while(result = captureMatcher.exec(x.source)) {
		if (!inCClass) {
			if (result[0] === '(') count += 1
			continue
		}
		if (result[0] === '[') inCClass = true
		else if (result[0] === ']') inCClass = false
	}
	return count
})

var numRefMatcher = /\\[^1-9]|[\[\]]|\\(\d{1,2})|\(\?:\$ \^depth:(\d+),n:(\d+)\)/g

var hasRefs = mdMemo('hasRefs', function hasRefs(x) {
	var hasRefs = false, hasFinalRef = false, inCClass = false, result
	numRefMatcher.lastIndex = 0
	while(result = numRefMatcher.exec(x.source)) {
		// const [match, refIndex, depth, thunkIndex] = result
		if (!inCClass && (result[1] != null || result[2] != null)) {
			hasRefs = true
			if (numRefMatcher.lastIndex === x.source.length) hasFinalRef = true
			continue
		}
		if (result[0] === '[') inCClass = true
		else if (result[0] === ']') inCClass = false
	}
	metadata.set(x.key, 'hasFinalRef', hasFinalRef)
	return hasRefs
})

var tokenMatcher = /(\\.)|[-()|\[\]]((?=\?(?:=|!|<=|<!))?)/g

// When composing expressions into a sequence, regexps that have a top-level
// choice operator must be wrapped in a non-capturing group. This function
// detects whether the group is needed or not.

export var isDisjunction = mdMemo('isDisjunction', function isDisjunction(x) {
	if (x.source.indexOf('|') === -1) return false
	var depth = 0, inCClass = false, result
	tokenMatcher.lastIndex = 0
	while(result = tokenMatcher.exec(x.source)) {
		// const [match, escape] = result
		if (result[1] != null) continue
		if (!inCClass && result[0] === '(') depth++
		if (!inCClass && result[0] === ')') depth--
		if (!inCClass && (result[0] === '[' || result[0] === '[-')) inCClass = true
		if (inCClass && result[0] === ']') inCClass = false
		if (depth === 0 && !inCClass && result[0] === '|') return true
	}
	return false
})

// Helper function for needsWrappingForQuantifier
export var isOneGroupOrAssertion = mdMemo('isOneGroupOrAssertion', function isOneGroupOrAssertion(x) {
	var source = x.source
	if (source.charAt(0) !== '(' || source.charAt(source.length - 1) !== ')') return false
	var depth = 0, inCClass = false, result
	tokenMatcher.lastIndex = 0
	while(result = tokenMatcher.exec(source)) {
		// const [match, escape] = result
		if (result[1] != null) {
			if (result.index === source.length - 2) return false
			continue
		}
		if (!inCClass && result[0] === '(') depth++
		if (!inCClass && result[0] === ')') {
			depth--
			if (depth === 0 && result.index !== source.length - 1) return false
		}
		if (!inCClass && (result[0] === '[' || result === '[-')) inCClass = true
		if (inCClass && result[0] === ']') inCClass = false
	}
	return true
})

var oneEscapeOrCharClassMatcher = /^\\[^]$|^\[(?:\\[^]|[^\]])*\]$/

var pEscapeMatcher = /^\\p\{[A-Z-a-z][A-Za-z=]*\}$/

// Determine if a pattern can take a suffix operator or if a non-capturing group
// is needed around it.
// We can safely have false negatives (consequence: useless non-capturing groups)
// whereas false positives would be bugs. We do have some false positives:
// some charsets will be marked as non-atomic.
export function needsWrappingForQuantifier(x) {
	var source = x.source
	if (source == null || source === '^' || source === '$' || source === '\\b' || source === '\\B') throw new SyntaxError("Nothing to repeat: /"+(source || '(?:)')+"/")
	// No need to look for standalone \k escapes, the are illegal in U and N mode, an non-atomic otherwise.
	if (
		source.length === 1 
		|| oneEscapeOrCharClassMatcher.test(source) 
		|| $flagValidator.U && pEscapeMatcher.test(source)
	) return false

	var og = isOneGroupOrAssertion(x)
	if (!og) return true
	if (/^\(\?<?[!=]/.test(source)) throw new SyntaxError("Nothing to repeat: /"+source+"/")
	return false
}

// - - - - - - - - - - - - - - - - //
//- - - -     - - -     - -     -  //
//                                 //
//    ,---                         //
//    |~  . .  , ,--. ,--. ,--.    //
//    |   |  }{  |--´ |    `--.    //
//    '   ' ´  ` `--´ '    `--´    //
//                                 //
//  -     - -     - - -     - - - -//
// - - - - - - - - - - - - - - - - //


// Procedure that validate or update patterns when necessary

var loneBracketMatcher = /\{\d+,?\d*\}|\\[^]|\]|\[|\}/g

// fixes non-u regexps for unicode promotion, if needed
// - escapes lone brackets
// - updates the . to and [^] to explicit ranges that exclude the astral characters
function promoteNonUnicodeToUnicode (source) {
	var inCClass = false
	return source.replace(loneBracketMatcher, function(match) {
		if (match === '[') inCClass = true
		if (match === ']') {
			if (inCClass) inCClass = false
			else return '\\]'
		}
		if (!inCClass) {
			if(match === '}') return '\\}'
		}
		return match
	})
}


// numeric backrefs must be updated for proper composition
// this ensures that sequence(/()\1/, /()\1/) becomes /()\1()\2/
function $$_fixRefs(initialOffset) {
	var count = initialOffset
	return function (x) {
		if (x.kind === 'regexp' || x.kind === 'result') {
			if (hasRefs(x)) {
				$refAndCap.hasRefs = true
				var inCClass = false
				x.source = x.source.replace(numRefMatcher, function(match, refIndex, depth, thunkIndex) {
					if (!inCClass) {
						if (refIndex != null) {
							var fixedRefIndex = (Number(refIndex) + count)
							if (fixedRefIndex > 99) throw new RangeError("Too many back references")

							return '\\' + String(fixedRefIndex)
						} else if (depth != null) {
							if (depth === '0') return '\\' + String(thunkIndex)
							else return '(?:$ ^depth:' + (Number(depth) -1) + ',n:' + thunkIndex + ')'
						}
					}
					if (match === '[') inCClass = true
					else if (match === ']') inCClass = false
					return match
				})
			}

			$refAndCap.hasFinalRef = !!metadata.get(x.key, 'hasFinalRef')
			count += countCaptures(x)
		}
		// overwritten several times, the final value is the real total
		$refAndCap.captureCount = count
		return x
	}
}

var dotMDotSMatcher = /\\.|\.|\(\?:\^\|\(\?<=\[\\n\\r\\u2028\\u2029\]\)\)|\(\?:\$\|\(\?=\[\\n\\r\\u2028\\u2029\]\)\)|\[|\]|\^|\$/g
function fixForFlags(x) {
	var source = x.source
	if($flagValidator.U && (x.kind === 'regexp' && !x.key.unicode || x.kind === 'result' && !metadata.get(x.key, 'unicode'))) {
			if(hasUProblem(source)) throw new SyntaxError("Can't upgrade the RegExp to Unicode /"+ source +"/" + x.kind === 'regexp' ? x.key.flags : '')
			x.source = promoteNonUnicodeToUnicode(source)
	}
	var inCClass = false
	if (x.kind === 'regexp' && (x.key.dotAll || x.key.multiline)) x.source = source.replace(dotMDotSMatcher, function(match) {
		if (!inCClass) {
			if (match === '[') inCClass = true
			return (x.key.dotAll && match === '.') ? '[^]' 
			: (x.key.multiline && match === '^'&& canFoldM) ? '(?:^|(?<=[\\n\\r\\u2028\\u2029]))'
			: (x.key.multiline && match === '$' && canFoldM) ? '(?:$|(?=[\\n\\r\\u2028\\u2029]))'
			: match
		} else {
			if (match === ']') inCClass = false
			return match
		}
		
	})
	return x
}

// ensures that each flag appears only once
export var flagsMatcher = new RegExp('^(?:([' + allFlags.join('') + '])(?!.*\\1))*$')

function $$_checkFlags(x) {
	var flags = x.key.flags

	if (!flagsMatcher.test(flags)) throw new TypeError("Unkown flags: " + flags.replace(new RegExp('['+allFlags.join()+']', 'g'), ''))

	var hasU = !!x.key.unicode
	var hasI = x.key.ignoreCase
	var hasM = x.key.multiline

	if ($flagValidator.I != null && hasI !== $flagValidator.I) throw new SyntaxError("Can't combine i and non-i regexps: " + x.key)
	if (!canFoldM && $flagValidator.M != null && hasI !== $flagValidator.M) throw new SyntaxError("Can't combine m and non-m regexps: " + x.key)

	$flagValidator.I = hasI
	$flagValidator.M = hasM
	$flagValidator.U = $flagValidator.U || hasU
	return x
}


//+
var directionNames = {'-1': 'backward', '1': 'forward'}
function $$_checkDirection(x) {
	var d = metadata.get(x.key, 'direction')
	if (d * $direction.current === -1)  throw new TypeError(
		"Illegal " + directionNames[d] + " RegExp argument while building a " + directionNames[$direction.current] + " one: /" + x.source + "/"
	)
	if (d !== 0) $refAndCap.hasRefs = true
	return x
}

// joining is done from the end, using reduceRight.
// the accumulator `x2` holds the tail of the results
// it starts with a `null` value

function join(forEither) {
	return forEither
	? function(x2, x1){
		x2.source = x2.source == null ? x1.source : x1.source + '|' + x2.source
		return x2
	}
	: function(x2, x1){
		x2.source = x2.source == null 
		? x1.source 
		: x1.source + (
			// corner case where a numeric ref is followed by a number
			x1.kind !== 'string' 
			// sets the 'hasFinalRef' metadata as a side effect
			&& hasRefs(x1)
			&& metadata.get(x1.key, 'hasFinalRef') 
			&& (/^\d/.test(x2.source))
			? '(?:)'
			: ''
		) + x2.source
	
		return x2
	}
}

// - - - - - - - - - - - - - - - - - - - - - - - - //
//- - - - -     - - - - -     - -     - -     -    //
//                                                 //
//    ,--.                  |                      //
//    |    ,--. ,--. ,--.   |   ,--. ,--. ' ,--.   //
//    |    |  | |    |--´   |   |  | |  | | |      //
//    `--´ `--´ '    `--´   `-- `--´ `--| ' `--´   //
//                                   `--´          //
//                                                 //
//    -     - -     - -     - - - - -     - - - - -//
// - - - - - - - - - - - - - - - - - - - - - - - - //

// Core Logic

// the $ prefix is there to denote engine state as stack-managed globals

// manages the logic relating to parsing direction
// (look behind applies the patterns backwards).
// Avoid mixing in back references intended to
// match in one direction inside a regexp that
// goes the other way.
export var $direction = {
	current: 1,
}

export var $flagValidator
var $refAndCap

export function $$_resetRefCapsAndFlags() {
	// atoms and direction
	$refAndCap = {hasRefs: false, hasFinalRef: false, captureCount: 0}
	$flagValidator = {U: false, I: null, M: null}
}

// makes sure `assemble()` is reentrant by stashing and popping
// back global state according to the stack depth. Must be `.apply()`ed or `.call()`ed
// passing the target function as context.
// Used by both the aforementioned functions, and the public API.

function $$_reentrantRefCapFlag(f) {
	var previousRnC = $refAndCap
	var previousFV = $flagValidator
	try {return f()} finally {
		$refAndCap = previousRnC
		$flagValidator = previousFV
	}
}

// used for adding groups, assertions and quantifiers

export function decorate(x, options) {
	// console.log({x, options})
	if(!options.condition || options.condition(x)) x.source = options.wrapper[0] + (x.source || '') + options.wrapper[1]
	if (options.suffix) x.source += options.suffix
	return x
}

function wrapIfTopLevelDisjunction(x) {
	return decorate(x, {
		condition: function(x) { return (x.kind === 'regexp' || x.kind === 'result') && isDisjunction(x)},
		wrapper: ['(?:', ')']
	})
}

var stringNormalizerMatcher = /[.?*+^$[\]\\(){}|]/g

function handleOtherTypes (x) {
	if (typeof x === 'number' || typeof x === 'string') return {
		key: null,
		kind: 'string',
		source: String(x).replace(stringNormalizerMatcher, '\\$&')
	}
	throw new TypeError("Can't compose type " + typeof x + " as RegExp")
}

// The recursive brain of compose-regexp

export function assemble(patterns, either, contextRequiresWrapping, initialCapIndex) {
	// console.log({patterns})
	// this and [1] below could probably be simplified
	contextRequiresWrapping = contextRequiresWrapping || patterns.length > 1
	return map.call(patterns, function processItem(item) {
		return (
				// [1] see comment above
				(!either && contextRequiresWrapping) ? wrapIfTopLevelDisjunction : identity
			)(
				Array.isArray(item) ? assemble(item, false, contextRequiresWrapping, 0)
				// thunks are materialized downstream
				: typeof item === 'function' ? processItem($$_reentrantRefCapFlag(item))
				: (item instanceof RegExpRef) ? $$_checkDirection($$_checkFlags({
					key: item,
					kind: 'regexp',
					source: getSource(item)
				}))
				: handleOtherTypes(item, contextRequiresWrapping)
			)
		// fixForFlags and $$_fixRefs can't be inlined in the first mat, above they rely on side effects of the
		// `check` functions having all happenned before they run.
		// at best they could be combined into a single function.
	}).map(fixForFlags).map($$_fixRefs(initialCapIndex)).reduceRight(join(either), {
		key: metadata.set(null, Object.assign({
			direction: $refAndCap.hasRefs ? $direction.current : 0,
			isDisjunction: either && (patterns.length > 1 || patterns.length === 1  && (patterns[0] instanceof RegExpRef) && metadata.get(patterns[0], 'isDisjunction')),
			unicode: $flagValidator.U
		}, $refAndCap)),
		kind: 'result', 
		source: null
	})
}

function getFlags(){
	return (($flagValidator.I ? 'i' : '') + (canFoldM ? '' : $flagValidator.M ? 'm' : '') + ($flagValidator.U ? 'u' : ''))
}

export function finalize(x, options) {
	// console.trace({x})
	// const {flags, direction} = options
	options = options || {}
	var flags = hasOwn.call(options, 'flags') ? options.flagsOp(getFlags(), options.flags) : getFlags()
	var result = new RegExp((x.source || ''), flags)
	metadata.set(result, metadata.set(x.key, {}))
	metadata.set(result, 'source', x.source)
	if (hasOwn.call(options, 'direction')) metadata.set(result, 'direction', options.direction)
	return result
}
