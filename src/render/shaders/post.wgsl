// HDR -> display: exposure, ACES approximation, vignette, sRGB encode.
import { acesApprox, linearToSrgb } from "./common.wgsl";

struct Post {
  exposure: f32,
  vignette: f32,     // 0 = none, 1 = strong
  encodeSrgb: f32,   // 1 when the output format is not an *-srgb format
  aspect: f32,       // output width / height
}

@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var hdrSampler: sampler;
@group(0) @binding(2) var<uniform> post: Post;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let radiance = textureSampleLevel(hdr, hdrSampler, uv, 0.0).rgb;
  var c = acesApprox(radiance * post.exposure);
  let p = (uv - 0.5) * vec2f(post.aspect, 1.0);
  let fall = smoothstep(0.35, 1.05, length(p));
  c = c * (1.0 - post.vignette * fall);
  if (post.encodeSrgb > 0.5) { c = linearToSrgb(c); }
  return vec4f(c, 1.0);
}
