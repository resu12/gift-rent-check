import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsImages, analyticsImageUrl } from './analyticsImages.ts';
import { friendlyMainnetAddress } from '../serverless/walletIdentity.ts';

const address = (byte: string) => `0:${byte.repeat(32)}`;
const gift = (byte = '11', collection_name: string | null = 'Heart Locket', image_url: string | null = `https://images.example/gift-${byte}.webp`) => ({
  nft_address: address(byte), collection_name, image_url, collection_conflict: false,
});

test('analytics gift artwork matches raw and friendly NFT identity without name matching', () => {
  const first=gift(),second={...gift('22'),nft_address:friendlyMainnetAddress(address('22'))!};
  const result=analyticsImages([first,second]);
  assert.equal(result.gifts.get(address('11')),first.image_url);
  assert.equal(result.gifts.get(address('22')),second.image_url);
  assert.equal(result.gifts.get(address('33')),undefined);
  assert.equal(result.gifts.size,2);
  assert.equal(analyticsImages([{...gift(),nft_address:'not an address'}]).gifts.size,0);
});

test('collection artwork uses full normalized names with a stable representative independent of input order', () => {
  const first=gift('11',' Heart\u00a0  Locket '),second=gift('22','heart locket'),third=gift('33','Heart');
  const normal=analyticsImages([first,second,third]),reversed=analyticsImages([third,second,first]);
  assert.deepEqual([...normal.collections],[...reversed.collections]);
  assert.equal(normal.collections.get('name:heart locket'),first.image_url);
  assert.equal(normal.collections.get('name:heart'),third.image_url);
  assert.equal(normal.collections.get('name:heart lockets'),undefined,'no singular/plural aliases');
  assert.equal(normal.collections.get('name:locket'),undefined,'no substring matching');
});

test('conflicted collection names never lend artwork to that collection but exact gifts keep their pictures', () => {
  const conflicted={...gift('11'),collection_conflict:true},valid=gift('22');
  const result=analyticsImages([conflicted,valid]);
  assert.equal(result.gifts.get(address('11')),conflicted.image_url);
  assert.equal(result.collections.get('name:heart locket'),valid.image_url);
  assert.equal(analyticsImages([conflicted]).collections.size,0);
  assert.equal(analyticsImages([gift('33',null)]).collections.size,0);
});

test('missing or unsafe artwork remains an icon fallback and safe public HTTPS is retained', () => {
  for(const url of [undefined,null,'','data:image/svg+xml,<svg/>','javascript:alert(1)','http://images.example/a.png',
    'https://user:password@images.example/a.png','https://user@images.example/a.png',' https://images.example/a.png',
    'https://images.example/a b.png','https://images.example/a\n.png','https://images.example/a\\b.png','https://images.example/'+ 'a'.repeat(2049)]) {
    assert.equal(analyticsImageUrl(url),undefined,`${String(url).slice(0,40)} must use fallback`);
    assert.equal(analyticsImages([gift('11','Heart Locket',url??null)]).gifts.size,0);
  }
  assert.equal(analyticsImageUrl('https://images.example/a%20b.webp'),'https://images.example/a%20b.webp');
  assert.equal(analyticsImageUrl('https://images.example/a.webp?size=80'),'https://images.example/a.webp?size=80');
});

test('image indexing does not mutate gifts or add artwork to statistics records', () => {
  const gifts=[gift('22'),gift('11')],copy=structuredClone(gifts);
  const indexed=analyticsImages(gifts);assert.deepEqual(gifts,copy);
  assert.deepEqual(Object.keys(indexed).sort(),['collections','gifts']);
  assert.equal(indexed.gifts.size,2);
});
