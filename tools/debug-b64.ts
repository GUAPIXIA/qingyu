const expected = 'bd4w2UrfhgBz6DYVVGQe50qic0yrXaVzMHayP3G66ivlWf20WFJur21mDexsKLqqvjQVLCdhyh+lvIUVrJ8Y+bRVrNIsTEgFFR+2ww=='
const actual = 'bd4w2UrfhgBz6DYVVGQe50qic0yrXaVzMHayP3G66ivlWf20WFJur21mDexsKLqqvjQVLCdhyh+lvIUVGnoMMSXRmJ2z0RuQFu6v9g=='
const tsBody = '6dde30d94adf860073e8361554641ee74aa2734cab5da5733076b23f71baea2be559fdb458526eaf6d660dec6c28baaabe34152c2761ca1fa5bc8515'
const tsTag = 'ac9f18f9b455acd22c4c4805151fb6c3'
const e = Buffer.from(expected, 'base64')
const a = Buffer.from(actual, 'base64')
console.log('e len', e.length, 'a len', a.length)
console.log('e body', e.subarray(0, e.length - 16).toString('hex'))
console.log('a body', a.subarray(0, a.length - 16).toString('hex'))
console.log('e tag', e.subarray(e.length - 16).toString('hex'))
console.log('a tag', a.subarray(a.length - 16).toString('hex'))
console.log('ts body match e?', tsBody === e.subarray(0, e.length - 16).toString('hex'))
console.log('ts tag match e?', tsTag === e.subarray(e.length - 16).toString('hex'))
console.log('body e==a?', e.subarray(0, e.length - 16).equals(a.subarray(0, a.length - 16)))
// find first difference
for (let i = 0; i < e.length; i++) {
  if (e[i] !== a[i]) {
    console.log('first diff at byte', i, 'of', e.length, 'e', e[i], 'a', a[i])
    break
  }
}
