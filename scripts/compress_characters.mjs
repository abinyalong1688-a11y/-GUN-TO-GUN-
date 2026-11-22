// compress_characters.mjs — character asset pipeline:
//   assets_raw/characters/*.glb  (originals from Tripo / make_test_rig — source of truth)
//     → this script → assets/characters/*.glb  (compressed, what build.mjs embeds)
//
// SKINNED-CHARACTER RULE (the expensive lesson from guizang skill packaging.md):
//   reorder + EXT_meshopt_compression, NEVER quantize. Quantizing a skinned mesh puts the
//   dequantization scale on the bone nodes; baked animation tracks carry scale=1 and squash
//   characters mid-run ("dev fine, packaged half-size"). Costs ~30-40% size vs quantized,
//   but behaviour is identical to the raw file.
//
// RIGID PROPS (helmet_m / helmet_f): same meshopt path, plus textures downscaled 2048² → 512²
// (Tripo ships three 2048² maps ≈ 1.9 MB per helmet; on a ~25 cm head 512² is already more
// than the screen shows, and every byte is base64-embedded in the single-file build).
//
// Run: node scripts/compress_characters.mjs             (all)
//      node scripts/compress_characters.mjs helmet_m    (selected)
import {NodeIO} from '@gltf-transform/core';
import {EXTMeshoptCompression} from '@gltf-transform/extensions';
import {dedup,weld,reorder,textureCompress} from '@gltf-transform/functions';
import {MeshoptEncoder} from 'meshoptimizer';
import sharp from 'sharp';
import {readFileSync,writeFileSync,mkdirSync} from 'fs';
import {dirname,join} from 'path';
import {fileURLToPath} from 'url';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const SRC=join(ROOT,'assets_raw','characters');
const OUT=join(ROOT,'assets','characters');
const NAMES=process.argv.slice(2).length?process.argv.slice(2):['male','female','helmet_m','helmet_f'];
const isProp=name=>name.startsWith('helmet_');
const PROP_TEX=512;

await MeshoptEncoder.ready;
const io=new NodeIO()
  .registerExtensions([EXTMeshoptCompression])
  .registerDependencies({'meshopt.encoder':MeshoptEncoder});

for(const name of NAMES){
  const src=join(SRC,`${name}.glb`);
  const before=readFileSync(src).length;
  const doc=await io.read(src);
  await doc.transform(
    dedup(),                                   // duplicate accessors/materials → shared
    weld(),                                    // merge duplicate vertices → better compression
    reorder({encoder:MeshoptEncoder,target:'size'}), // vertex cache order, NO quantize() transform
  );
  // formats kept (jpeg stays jpeg, png stays png) → no new texture extensions for the loader
  if(isProp(name))await doc.transform(textureCompress({encoder:sharp,resize:[PROP_TEX,PROP_TEX]}));
  // EncoderMethod.QUANTIZE is the writer's per-accessor encode mode — NOT the forbidden
  // quantize() transform (that one rescales vertices and parks the dequantization on the
  // bones, which shrinks skinned characters mid-animation). FILTER mangles vertex colours.
  doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
  const bytes=await io.writeBinary(doc);
  mkdirSync(OUT,{recursive:true});
  writeFileSync(join(OUT,`${name}.glb`),bytes);
  console.log(`✓ ${name}.glb  ${(before/1024).toFixed(0)} KB → ${(bytes.length/1024).toFixed(0)} KB`);
}
