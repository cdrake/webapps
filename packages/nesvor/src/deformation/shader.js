export function deformationShader(model) {
  const layers = model.layers.map(l => `Layer(${l.input}u,${l.output}u,${l.weightOffset}u,${l.biasOffset}u,${l.inputOffset}u,${l.outputOffset}u,${l.hidden ? 1 : 0}u)`).join(',');
  return `
struct Layer { inputs:u32, outputs:u32, weight:u32, bias:u32, source:u32, destination:u32, hidden:u32 }
struct Config { count:u32, backward:u32, padding:vec2u }
@group(0) @binding(0) var<storage,read> parameters:array<f32>;
@group(0) @binding(1) var<storage,read_write> gradients:array<atomic<u32>>;
@group(0) @binding(2) var<storage,read> queries:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> io:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> failure:atomic<u32>;
@group(0) @binding(5) var<uniform> config:Config;
const layers=array<Layer,3>(${layers});
const resolutions=array<f32,${model.levels}>(${model.resolutions.map(x => `${x}.0`).join(',')});
const extent=vec3f(${model.extent.map(x => `${Number(x).toExponential()}`).join(',')});
const lower=vec3f(${model.boundingBox[0].map(x => `${Number(x).toExponential()}`).join(',')});
const features=${model.config.features}u;
const encoded=${model.levels * model.config.features}u;
const embeddingFeatures=${model.config.embeddingFeatures}u;
const embeddingOffset=${model.embeddingOffset}u;
const tableSize=${model.size}u;
const outputOffset=${model.layers.at(-1).outputOffset}u;
fn addGradient(index:u32,value:f32) {
  if (value == 0.0) { return; }
  if (abs(value)>3.402823e38 || value!=value) { atomicStore(&failure,1u); return; }
  var previous=atomicLoad(&gradients[index]);
  loop {
    let next=bitcast<f32>(previous)+value;
    if (abs(next)>3.402823e38 || next!=next) { atomicStore(&failure,1u); return; }
    let result=atomicCompareExchangeWeak(&gradients[index],previous,bitcast<u32>(next));
    if (result.exchanged) { break; }
    previous=result.old_value;
  }
}
fn hash(p:vec3i)->u32 {
  let u=vec3u(p);
  return (u.x ^ (u.y*2654435761u) ^ (u.z*805459861u)) & (tableSize-1u);
}
fn cornerJet(f:vec3f, d:vec3f, corner:u32)->vec4f {
  let bits=vec3u(corner>>2u,(corner>>1u)&1u,corner&1u);
  let v=select(vec3f(1.0)-f,f,bits==vec3u(1u));
  let g=select(-d,d,bits==vec3u(1u));
  return vec4f(v.x*v.y*v.z,g.x*v.y*v.z,v.x*g.y*v.z,v.x*v.y*g.z);
}
@compute @workgroup_size(32)
fn run(@builtin(global_invocation_id) id:vec3u) {
  let q=id.x;
  if(q>=config.count) { return; }
  var jets:array<vec4f,${model.activationSize}>;
  let point=queries[q].xyz;
  let slice=bitcast<u32>(queries[q].w);
  let normalized=(point-lower)/extent;
  for(var l=0u;l<${model.levels}u;l++) {
    let scaled=normalized*resolutions[l];
    let base=vec3i(floor(scaled));
    let t=fract(scaled);
    let smoothed=t*t*(vec3f(3.0)-2.0*t);
    let derivative=6.0*t*(vec3f(1.0)-t)*resolutions[l]/extent;
    for(var corner=0u;corner<8u;corner++) {
      let bits=vec3i(i32(corner>>2u),i32((corner>>1u)&1u),i32(corner&1u));
      let index=(l*tableSize+hash(base+bits))*features;
      let jet=cornerJet(smoothed,derivative,corner);
      for(var f=0u;f<features;f++) { jets[l*features+f]+=parameters[index+f]*jet; }
    }
  }
  for(var f=0u;f<embeddingFeatures;f++) { jets[encoded+f]=vec4f(parameters[embeddingOffset+slice*embeddingFeatures+f],0.0,0.0,0.0); }
  for(var l=0u;l<3u;l++) {
    let layer=layers[l];
    for(var o=0u;o<layer.outputs;o++) {
      var jet=vec4f(parameters[layer.bias+o],0.0,0.0,0.0);
      for(var i=0u;i<layer.inputs;i++) { jet+=parameters[layer.weight+o*layer.inputs+i]*jets[layer.source+i]; }
      if(layer.hidden!=0u) { let value=tanh(jet.x); jet=vec4f(value,(1.0-value*value)*jet.yzw); }
      jets[layer.destination+o]=jet;
    }
  }
  var jacobian:array<vec3f,3>;
  var result=point;
  for(var o=0u;o<3u;o++) {
    result[o]+=extent[o]*jets[outputOffset+o].x;
    jacobian[o]=extent[o]*jets[outputOffset+o].yzw;
    jacobian[o][o]+=1.0;
  }
  var residual:array<vec3f,3>;
  var penalty=0.0;
  for(var o=0u;o<3u;o++) {
    for(var p=0u;p<3u;p++) { residual[o][p]=dot(jacobian[o],jacobian[p])-select(0.0,1.0,o==p); }
    penalty+=dot(residual[o],residual[o]);
  }
  if(penalty!=penalty || penalty>3.402823e38) { atomicStore(&failure,1u); return; }
  let cotangent=io[q*3u];
  io[q*3u+1u]=vec4f(result,penalty);
  if(config.backward==0u) { return; }
  var coordinateGradient=cotangent.xyz;
  for(var backwardPass=0u;backwardPass<2u;backwardPass++) {
    if(backwardPass==1u && cotangent.w==0.0) { continue; }
    var adjoints:array<vec4f,${model.activationSize}>;
    for(var clearIndex=0u;clearIndex<${model.activationSize}u;clearIndex++) { adjoints[clearIndex]=vec4f(0.0); }
    for(var o=0u;o<3u;o++) {
      if(backwardPass==0u) { adjoints[outputOffset+o].x=cotangent[o]*extent[o]; }
      else {
        var g=vec3f(0.0);
        for(var p=0u;p<3u;p++) { g+=residual[o][p]*jacobian[p]; }
        adjoints[outputOffset+o].yzw=4.0*cotangent.w*extent[o]*g;
      }
    }
    for(var li=3u;li>0u;li--) {
      let layer=layers[li-1u];
      for(var o=0u;o<layer.outputs;o++) {
        var g=adjoints[layer.destination+o];
        if(layer.hidden!=0u) {
          let jet=jets[layer.destination+o];
          g=vec4f(g.x*(1.0-jet.x*jet.x)-2.0*jet.x*dot(g.yzw,jet.yzw),g.yzw*(1.0-jet.x*jet.x));
        }
        addGradient(layer.bias+o,g.x);
        for(var i=0u;i<layer.inputs;i++) {
          let wi=layer.weight+o*layer.inputs+i;
          addGradient(wi,dot(g,jets[layer.source+i]));
          adjoints[layer.source+i]+=parameters[wi]*g;
        }
      }
    }
    if(backwardPass==0u) {
      for(var f=0u;f<embeddingFeatures;f++) { addGradient(embeddingOffset+slice*embeddingFeatures+f,adjoints[encoded+f].x); }
      for(var f=0u;f<encoded;f++) { coordinateGradient+=adjoints[f].x*jets[f].yzw; }
    }
    for(var l=0u;l<${model.levels}u;l++) {
      let scaled=normalized*resolutions[l];
      let base=vec3i(floor(scaled));
      let t=fract(scaled);
      let smoothed=t*t*(vec3f(3.0)-2.0*t);
      let derivative=6.0*t*(vec3f(1.0)-t)*resolutions[l]/extent;
      for(var corner=0u;corner<8u;corner++) {
        let bits=vec3i(i32(corner>>2u),i32((corner>>1u)&1u),i32(corner&1u));
        let index=(l*tableSize+hash(base+bits))*features;
        let jet=cornerJet(smoothed,derivative,corner);
        for(var f=0u;f<features;f++) { addGradient(index+f,dot(adjoints[l*features+f],jet)); }
      }
    }
  }
  io[q*3u+2u]=vec4f(coordinateGradient,0.0);
}
`;
}
