(()=>{'use strict';
if(matchMedia('(prefers-reduced-transparency: reduce)').matches)return;
const canvas=document.createElement('canvas');canvas.id='liquid-webgl';canvas.setAttribute('aria-hidden','true');
Object.assign(canvas.style,{position:'fixed',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'0'});
document.body.prepend(canvas);
const gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:false});
if(!gl){canvas.remove();return;}
const vs='attribute vec2 p;varying vec2 v;void main(){v=(p+1.)*.5;gl_Position=vec4(p,0.,1.);}';
const fs=`precision highp float;
varying vec2 v;
uniform vec2 resolution;
uniform vec4 lenses[12];
uniform float count;
uniform float time;
uniform float dark;
vec3 scene(vec2 uv){
 vec2 p=uv;
 vec3 base=mix(vec3(.92,.95,1.),vec3(.96,.94,1.),p.x*.6+p.y*.3);
 vec3 night=mix(vec3(.055,.09,.17),vec3(.13,.11,.25),p.x*.6+p.y*.3);
 vec3 col=mix(base,night,dark);
 vec2 c1=vec2(.17,.77),c2=vec2(.86,.22),c3=vec2(.57,.55);
 float a=exp(-dot(p-c1,p-c1)*15.);
 float b=exp(-dot(p-c2,p-c2)*14.);
 float c=exp(-dot(p-c3,p-c3)*23.);
 col+=vec3(.19,.31,.48)*a*(1.-dark*.45);
 col+=vec3(.28,.17,.40)*b*(1.-dark*.45);
 col+=vec3(.12,.18,.30)*c*(1.-dark*.35);
 return col;
}
void main(){
 vec2 uv=v;vec2 sampleUV=uv;float highlight=0.;float coverage=0.;
 for(int i=0;i<12;i++){
  if(float(i)>=count)break;
  vec4 box=lenses[i];vec2 center=box.xy;vec2 halfSize=max(box.zw,vec2(.001));
  vec2 q=(uv-center)/halfSize;
  vec2 aq=abs(q);float corner=.19;
  vec2 inner=aq-(1.-corner);
  float sd=length(max(inner,0.))+min(max(inner.x,inner.y),0.)-corner;
  float mask=1.-smoothstep(-.008,.008,sd);
  float rim=exp(-pow((sd+.035)*17.,2.));
  vec2 dir=normalize(q+vec2(.00001));
  float radial=length(q);
  float squash=1.-.22*exp(-pow((radial-.72)*3.2,2.));
  vec2 bend=q*squash+dir*(.075*exp(-pow((radial-.92)*5.,2.)));
  bend.x+=.025*sin(q.y*8.+time*.25)*mask;
  vec2 refracted=center+bend*halfSize;
  sampleUV=mix(sampleUV,refracted,mask*(1.-coverage));
  highlight+=rim*mask*(1.-coverage);
  coverage=max(coverage,mask);
 }
 vec3 col=scene(clamp(sampleUV,0.,1.));
 col=mix(col,col*1.12+vec3(.055,.07,.1),coverage*.26);
 col+=vec3(.18,.21,.26)*highlight*.48;
 gl_FragColor=vec4(col,1.);
}`;
function compile(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
let program;try{program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vs));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('shader link');}catch(e){canvas.remove();return;}
gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
const pos=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
const uR=gl.getUniformLocation(program,'resolution'),uL=gl.getUniformLocation(program,'lenses'),uC=gl.getUniformLocation(program,'count'),uT=gl.getUniformLocation(program,'time'),uD=gl.getUniformLocation(program,'dark');
const isMaintenance=!!document.querySelector('body > main .status');
const selectors=isMaintenance?'main,.symbol,.status':'.nav-shell,.simple-card,.collection-card,.shortcut-card,.card,.search,.empty,.button-blue';
let scheduled=false;
function render(){
 scheduled=false;const w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio||1,1.5);const cw=Math.round(w*dpr),ch=Math.round(h*dpr);
 if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;gl.viewport(0,0,cw,ch);}
 const arr=new Float32Array(48);let n=0;
 document.querySelectorAll(selectors).forEach(el=>{if(n>=12)return;const r=el.getBoundingClientRect();if(r.width<10||r.height<10||r.bottom<0||r.top>h)return;arr.set([(r.left+r.width/2)/w,1-(r.top+r.height/2)/h,r.width/(2*w),r.height/(2*h)],n*4);n++;});
 gl.uniform2f(uR,cw,ch);gl.uniform4fv(uL,arr);gl.uniform1f(uC,n);gl.uniform1f(uT,0);
 const dark=document.documentElement.dataset.theme==='dark'||(isMaintenance&&matchMedia('(prefers-color-scheme:dark)').matches);gl.uniform1f(uD,dark?1:0);
 gl.drawArrays(gl.TRIANGLES,0,6);
}
function request(){if(!scheduled){scheduled=true;requestAnimationFrame(render);}}
addEventListener('resize',request,{passive:true});addEventListener('scroll',request,{passive:true});new MutationObserver(request).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});request();
document.documentElement.classList.add('webgl-liquid-enabled');
})();