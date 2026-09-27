/** File names under claude-image-gen/models/<folder>/ (never copied into this repo). */
export const MODELS = {
  waiCheckpoint: 'waiIllustriousSDXL_v170.safetensors', // checkpoints/
  noobIpa: 'noobIPAMARK1_mark1.safetensors', // ipadapter/
  clipVisionBigG: 'CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors', // clip_vision/
  noobOpenpose: 'noob_openpose_pre.safetensors', // controlnet/
  animeSharp: '4x-AnimeSharp.safetensors', // upscale_models/
  qwenEditGguf: 'qwen-image-edit-2511-Q5_K_M.gguf', // unet/
  qwenEditLightning: 'Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors', // loras/
  qwenVlEncoder: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', // text_encoders/
  qwenImageVae: 'qwen_image_vae.safetensors', // vae/ (Qwen Edit and Anima)
  animaAesthetic: 'anima-aesthetic-v1.1.safetensors', // diffusion_models/
  animaTurbo: 'anima-turbo-v1.1.safetensors', // diffusion_models/
  animaEncoder: 'qwen_3_06b_base.safetensors', // text_encoders/
  animaPose: 'anima-lllite-pose-1.safetensors', // model_patches/
  animaLineart: 'anima-lllite-lineart-1.safetensors', // model_patches/
  klein: 'flux-2-klein-4b-fp8.safetensors', // diffusion_models/
  kleinEncoder: 'qwen_3_4b.safetensors', // text_encoders/
  flux2Vae: 'flux2-vae.safetensors', // vae/
} as const;
