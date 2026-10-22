// X-IOT P2P bridge harness (plan Task 1-2).
// Loads the vendor P2P lib (libobject_jni.so, arm64 Android) with a fake
// JNIEnv/JavaVM, drives StartPPPP against a real camera UID over the vendor
// relay, and on ON_LINE(2) starts the livestream and writes the raw video
// frames the camera sends (this device: MJPEG, a run of self-contained JPEG
// frames) to STDOUT (fd 1). Status/diagnostics go to STDERR (fd 2) only, as
// parseable lines `STATUS <uid> <type> <param>`. Runs until killed; exits
// non-zero if the video stalls so a supervisor can restart (reconnect).
//
// Build with NDK clang for aarch64-linux-android (see build-harness.sh); run
// under qemu-aarch64 with the bionic runtime image (see build-runtime.sh).
//
// Usage: harness <UID> <user> <pwd>   (env: XIOT_STREAM=1|2, default 1)
#define _GNU_SOURCE
#include <jni.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <unistd.h>
#include <pthread.h>
#include <signal.h>
#include <ucontext.h>
#include <link.h>
#include <errno.h>

static void *g_env_ptr;   // = &g_env, set in main before any callback
static long g_heals=0;
static void modoff(unsigned long a, char*out, int n){ // "<lib> +0xoff"
    Dl_info d; if(dladdr((void*)a,&d)&&d.dli_fname) snprintf(out,n,"%s +0x%lx",d.dli_fname,a-(unsigned long)d.dli_fbase);
    else snprintf(out,n,"0x%lx",a);
}
// A vendor thread reads its JNIEnv from channel+0x720; before the command
// thread fills it, that read yields 0 and the next `ldr Xt,[Xn]` faults at 0.
// Heal ONLY that exact shape: a 64-bit LDR whose base register is 0 → repoint
// the base at our fake env and retry. Anything else (null CALL, pc==0) is a
// real bug on the video path — log the site precisely and exit, never loop.
static void segv(int sig, siginfo_t*si, void*uc){
    ucontext_t*u=(ucontext_t*)uc;
    unsigned long pc=u->uc_mcontext.pc, lr=u->uc_mcontext.regs[30];
    if(si->si_addr==0 && g_env_ptr && pc>0x1000 && g_heals<100000){
        unsigned int insn=*(unsigned int*)pc;
        if((insn & 0xFFC00000u)==0xF9400000u){     // LDR Xt,[Xn{,#imm}] 64-bit
            int rn=(insn>>5)&0x1f;
            if(u->uc_mcontext.regs[rn]==0){ u->uc_mcontext.regs[rn]=(unsigned long)g_env_ptr; g_heals++; return; }
        }
    }
    char pcs[160], lrs[160]; modoff(pc,pcs,sizeof pcs); modoff(lr,lrs,sizeof lrs);
    char b[400]; int n=snprintf(b,sizeof b,
        "\n[SEGV] sig=%d addr=%p pc=%s lr=%s heals=%ld x0=0x%lx x8=0x%lx\n",
        sig,si->si_addr,pcs,lrs,g_heals,u->uc_mcontext.regs[0],u->uc_mcontext.regs[8]);
    write(2,b,n); _exit(42);
}
static void install_segv(void){ struct sigaction sa={0}; sa.sa_sigaction=segv; sa.sa_flags=SA_SIGINFO|SA_NODEFER; sigaction(SIGSEGV,&sa,0); }

// ---- tiny tagged handles ---------------------------------------------------
enum { T_CLASS = 1, T_METHOD, T_STR, T_BARR, T_OBJ };
typedef struct { int tag; } Hdr;
typedef struct { int tag; char name[128]; } Class;
typedef struct { int tag; char name[96]; char sig[160]; } Method;
typedef struct { int tag; char *s; } Str;
typedef struct { int tag; int len; unsigned char *b; } BArr;
typedef struct { int tag; } Obj;

static Obj g_ctx = { T_OBJ };          // stand-in android.content.Context
static long g_frames = 0, g_vbytes = 0;
static volatile int g_online = 0;      // set when PPPP status == ON_LINE(2)

// Write all n bytes of a video frame to stdout (fd 1); a short write on a pipe
// is normal, so loop. If the consumer went away (EPIPE) or the write fails,
// exit so the supervisor restarts the pipeline.
static void writeall_stdout(const void*buf, size_t n){
    const char*p = buf;
    while(n){
        ssize_t w = write(1, p, n);
        if(w < 0){ if(errno==EINTR) continue; _exit(6); }
        if(w == 0) _exit(6);
        p += w; n -= (size_t)w;
    }
}

static void log_env_idx(int);               // defined below; used by stubs.h
#include "stubs.h"                            // g_jni_names[], g_estubs[256]
static void log_env_idx(int i){ fprintf(stderr,"[jni] UNIMPL env idx=%d %s\n", i, i<JNI_NAME_COUNT?g_jni_names[i]:"?"); }
static intptr_t default_vm_stub(void)  { fprintf(stderr,"[jni] UNIMPL JavaVM slot\n"); return 0; }

// ---- implemented JNIEnv functions -----------------------------------------
static jint      f_GetVersion(JNIEnv*e){ return JNI_VERSION_1_6; }

static jclass    f_FindClass(JNIEnv*e, const char*n){
    Class*c=calloc(1,sizeof*c); c->tag=T_CLASS; snprintf(c->name,sizeof c->name,"%s",n?n:"?");
    fprintf(stderr,"[jni] FindClass(%s)\n", c->name); return (jclass)c;
}
static jmethodID f_mid(JNIEnv*e, jclass c, const char*n, const char*s){
    Method*m=calloc(1,sizeof*m); m->tag=T_METHOD;
    snprintf(m->name,sizeof m->name,"%s",n?n:"?"); snprintf(m->sig,sizeof m->sig,"%s",s?s:"?");
    fprintf(stderr,"[jni] MethodID(%s %s)\n", m->name, m->sig); return (jmethodID)m;
}
static jstring   f_NewStringUTF(JNIEnv*e, const char*u){
    Str*s=calloc(1,sizeof*s); s->tag=T_STR; s->s=strdup(u?u:""); return (jstring)s;
}
static const char* f_GetStringUTFChars(JNIEnv*e, jstring js, jboolean*iscopy){
    Str*s=(Str*)js; if(iscopy)*iscopy=JNI_FALSE; return s&&s->tag==T_STR? s->s : "";
}
static void      f_ReleaseStringUTFChars(JNIEnv*e, jstring js, const char*c){ (void)e;(void)js;(void)c; }
static jsize     f_GetStringUTFLength(JNIEnv*e, jstring js){ Str*s=(Str*)js; return s&&s->tag==T_STR?(jsize)strlen(s->s):0; }
static jsize     f_GetStringLength(JNIEnv*e, jstring js){ return f_GetStringUTFLength(e,js); }

static jbyteArray f_NewByteArray(JNIEnv*e, jsize len){
    BArr*a=calloc(1,sizeof*a); a->tag=T_BARR; a->len=len<0?0:len; a->b=calloc(1,a->len?a->len:1); return (jbyteArray)a;
}
static void f_SetByteArrayRegion(JNIEnv*e, jbyteArray ar, jsize st, jsize len, const jbyte*src){
    BArr*a=(BArr*)ar; if(!a||a->tag!=T_BARR||st<0||len<0||st+len>a->len) return; memcpy(a->b+st,src,len);
}
static void f_GetByteArrayRegion(JNIEnv*e, jbyteArray ar, jsize st, jsize len, jbyte*dst){
    BArr*a=(BArr*)ar; if(!a||a->tag!=T_BARR||st<0||len<0||st+len>a->len) return; memcpy(dst,a->b+st,len);
}
static jbyte* f_GetByteArrayElements(JNIEnv*e, jbyteArray ar, jboolean*ic){ BArr*a=(BArr*)ar; if(ic)*ic=JNI_FALSE; return a&&a->tag==T_BARR?(jbyte*)a->b:NULL; }
static void   f_ReleaseByteArrayElements(JNIEnv*e, jbyteArray ar, jbyte*p, jint m){ (void)e;(void)ar;(void)p;(void)m; }
static jsize  f_GetArrayLength(JNIEnv*e, jarray ar){ Hdr*h=(Hdr*)ar; return h&&h->tag==T_BARR?((BArr*)ar)->len:0; }

static const jchar* f_GetStringChars(JNIEnv*e, jstring js, jboolean*ic){ // real UTF-16 (ASCII widen)
    Str*s=(Str*)js; if(ic)*ic=JNI_FALSE; const char*u=(s&&s->tag==T_STR)?s->s:"";
    size_t n=strlen(u); jchar*w=calloc(n+1,sizeof(jchar)); for(size_t i=0;i<n;i++) w[i]=(unsigned char)u[i]; return w; }
static void f_ReleaseStringChars(JNIEnv*e, jstring js, const jchar*c){ free((void*)c); }
static jstring f_NewString(JNIEnv*e, const jchar*u, jsize len){ Str*s=calloc(1,sizeof*s); s->tag=T_STR; s->s=calloc(1,1); return (jstring)s; }
static jobject f_AllocObject(JNIEnv*e, jclass c){ Obj*o=calloc(1,sizeof*o); o->tag=T_OBJ; return (jobject)o; }
static jclass  f_GetObjectClass(JNIEnv*e, jobject o){ Class*c=calloc(1,sizeof*c); c->tag=T_CLASS; snprintf(c->name,sizeof c->name,"<obj>"); return (jclass)c; }
static jboolean f_IsInstanceOf(JNIEnv*e, jobject o, jclass c){ return JNI_TRUE; }
static JavaVM g_vm;  // tentative; completed with initializer below
static jint    f_GetJavaVM(JNIEnv*e, JavaVM**vm){ *vm=&g_vm; return JNI_OK; }
static void    f_GetStringUTFRegion(JNIEnv*e, jstring js, jsize st, jsize len, char*buf){ Str*s=(Str*)js; if(buf){ if(s&&s->tag==T_STR){ size_t n=strlen(s->s); if((size_t)st<n) strncpy(buf,s->s+st,len); else buf[0]=0; } else buf[0]=0; } }
static jobject f_NewGlobalRef(JNIEnv*e, jobject o){ return o; }
static void    f_DeleteGlobalRef(JNIEnv*e, jobject o){ (void)e;(void)o; }
static void    f_DeleteLocalRef(JNIEnv*e, jobject o){ (void)e;(void)o; }
static jobject f_NewObjectV(JNIEnv*e, jclass c, jmethodID m, va_list a){ Obj*o=calloc(1,sizeof*o); o->tag=T_OBJ; return (jobject)o; }
static jobject f_NewObject(JNIEnv*e, jclass c, jmethodID m, ...){ return f_NewObjectV(e,c,m,(va_list){0}); }
static jthrowable f_ExceptionOccurred(JNIEnv*e){ return NULL; }
static void    f_ExceptionClear(JNIEnv*e){ (void)e; }

// Walk a JNI arg signature and pull the interesting bits (byte[] + ints) out of
// a callback so we can prove video is arriving. Dumps the first byte[] stream.
static void dispatch_callback(const char*who, Method*m, va_list ap){
    if(!m||m->tag!=T_METHOD){ return; }
    const char*p = strchr(m->sig,'(');
    p = p? p+1 : m->sig;
    BArr*firstbuf=NULL; Str*firststr=NULL; int ints[8]; int ni=0;
    for(; *p && *p!=')'; ){
        if(*p=='L'){ void*o=va_arg(ap,void*); int isstr=!strncmp(p,"Ljava/lang/String;",18);
                     if(isstr && !firststr && o && ((Hdr*)o)->tag==T_STR) firststr=(Str*)o;
                     while(*p && *p!=';')p++; if(*p)p++; }
        else if(*p=='['){ p++; if(*p=='B'){ BArr*a=va_arg(ap,BArr*); if(!firstbuf)firstbuf=a; p++; }
                          else { (void)va_arg(ap,void*); if(*p)p++; } }
        else if(*p=='I'||*p=='S'||*p=='B'||*p=='C'||*p=='Z'){ int v=va_arg(ap,int); if(ni<8)ints[ni++]=v; p++; }
        else if(*p=='J'){ (void)va_arg(ap,long long); p++; }
        else if(*p=='F'){ (void)va_arg(ap,double); p++; }
        else if(*p=='D'){ (void)va_arg(ap,double); p++; }
        else p++;
    }
    int is_video = strstr(m->name,"Video")||strstr(m->name,"H264")||strstr(m->name,"H265")||strstr(m->name,"VideoData");
    if(firstbuf && firstbuf->tag==T_BARR){
        if(is_video){
            g_frames++; g_vbytes += firstbuf->len;
            // raw camera frame (JPEG for this device) straight to stdout; the
            // bridge's ffmpeg demuxes the MJPEG run and transcodes to H.264.
            if(firstbuf->len>0) writeall_stdout(firstbuf->b, (size_t)firstbuf->len);
            if(g_frames<=3 || g_frames%60==0)
                fprintf(stderr,"[VIDEO] %s frame#%ld len=%d total=%ld firstbytes=%02x %02x %02x %02x\n",
                    m->name,g_frames,firstbuf->len,g_vbytes,
                    firstbuf->len>0?firstbuf->b[0]:0,firstbuf->len>1?firstbuf->b[1]:0,
                    firstbuf->len>2?firstbuf->b[2]:0,firstbuf->len>3?firstbuf->b[3]:0);
        }
    }
    if(!is_video){
        // Stable, parseable status line for the supervisor (plan Task 4 parseStatus):
        //   STATUS <uid> <type> <param>
        if((strstr(m->name,"MsgNotify")||strstr(m->name,"MessageNotify")) && ni>=2){
            fprintf(stderr,"STATUS %s %d %d\n", firststr?firststr->s:"?", ints[0], ints[1]);
            if(ints[0]==0 && ints[1]==2) g_online=1;   // PPPP_STATUS_ON_LINE
        }
        fprintf(stderr,"[CB] %s(", m->name);
        for(int i=0;i<ni;i++) fprintf(stderr,"%s%d", i?",":"", ints[i]);
        fprintf(stderr,")%s\n", firstbuf?" +bytes":"");
        fflush(stderr);
    }
}

static void f_CallStaticVoidMethodV(JNIEnv*e, jclass c, jmethodID m, va_list a){ dispatch_callback("static",(Method*)m,a); }
static void f_CallStaticVoidMethod(JNIEnv*e, jclass c, jmethodID m, ...){ va_list a; va_start(a,m); dispatch_callback("static",(Method*)m,a); va_end(a); }
static void f_CallVoidMethodV(JNIEnv*e, jobject o, jmethodID m, va_list a){ dispatch_callback("inst",(Method*)m,a); }
static void f_CallVoidMethod(JNIEnv*e, jobject o, jmethodID m, ...){ va_list a; va_start(a,m); dispatch_callback("inst",(Method*)m,a); va_end(a); }

// ---- JavaVM invoke iface ---------------------------------------------------
static struct JNINativeInterface  g_iface;
static const struct JNINativeInterface *g_ifacep = &g_iface;
static JNIEnv g_env = (JNIEnv)&g_iface;     // env value points directly at the fn table; natives get &g_env and do *env + off

static jint f_GetEnv(JavaVM*vm, void**penv, jint v){ *penv=&g_env; return JNI_OK; }
static jint f_AttachCurrentThread(JavaVM*vm, JNIEnv**penv, void*a){ *penv=&g_env; return JNI_OK; }
static jint f_DetachCurrentThread(JavaVM*vm){ return JNI_OK; }

static struct JNIInvokeInterface g_vmiface;
static const struct JNIInvokeInterface *g_vmifacep = &g_vmiface;
static JavaVM g_vm = (JavaVM)&g_vmiface;     // vm value points directly at the invoke table (natives get &g_vm and do *vm + off)

static void build_tables(void){
    // fill every slot with a default stub, then override implemented ones
    void **es = (void**)&g_iface;  for(size_t i=0;i<sizeof(g_iface)/sizeof(void*);i++) es[i]=g_estubs[i];
    void **vs = (void**)&g_vmiface; for(size_t i=0;i<sizeof(g_vmiface)/sizeof(void*);i++) vs[i]=(void*)default_vm_stub;
    g_iface.GetVersion=f_GetVersion;
    g_iface.FindClass=f_FindClass;
    g_iface.GetMethodID=f_mid; g_iface.GetStaticMethodID=f_mid;
    g_iface.NewStringUTF=f_NewStringUTF; g_iface.GetStringUTFChars=f_GetStringUTFChars;
    g_iface.ReleaseStringUTFChars=f_ReleaseStringUTFChars; g_iface.GetStringUTFLength=f_GetStringUTFLength;
    g_iface.GetStringLength=f_GetStringLength;
    g_iface.NewByteArray=f_NewByteArray; g_iface.SetByteArrayRegion=f_SetByteArrayRegion;
    g_iface.GetByteArrayRegion=f_GetByteArrayRegion; g_iface.GetByteArrayElements=f_GetByteArrayElements;
    g_iface.ReleaseByteArrayElements=f_ReleaseByteArrayElements; g_iface.GetArrayLength=f_GetArrayLength;
    g_iface.NewGlobalRef=f_NewGlobalRef; g_iface.DeleteGlobalRef=f_DeleteGlobalRef; g_iface.DeleteLocalRef=f_DeleteLocalRef;
    g_iface.NewObject=f_NewObject; g_iface.NewObjectV=f_NewObjectV;
    g_iface.ExceptionOccurred=f_ExceptionOccurred; g_iface.ExceptionClear=f_ExceptionClear;
    g_iface.CallStaticVoidMethod=f_CallStaticVoidMethod; g_iface.CallStaticVoidMethodV=f_CallStaticVoidMethodV;
    g_iface.CallVoidMethod=f_CallVoidMethod; g_iface.CallVoidMethodV=f_CallVoidMethodV;
    g_iface.GetStringChars=f_GetStringChars; g_iface.ReleaseStringChars=f_ReleaseStringChars;
    g_iface.NewString=f_NewString; g_iface.AllocObject=f_AllocObject;
    g_iface.GetObjectClass=f_GetObjectClass; g_iface.IsInstanceOf=f_IsInstanceOf;
    g_iface.GetJavaVM=f_GetJavaVM; g_iface.GetStringUTFRegion=f_GetStringUTFRegion;
    g_vmiface.GetEnv=f_GetEnv; g_vmiface.AttachCurrentThread=f_AttachCurrentThread;
    g_vmiface.AttachCurrentThreadAsDaemon=f_AttachCurrentThread;
    g_vmiface.DetachCurrentThread=f_DetachCurrentThread;
    // authoritative real slot indices from jni.h for the funcs we rely on
    #define OFF(f) (int)(offsetof(struct JNINativeInterface, f)/sizeof(void*))
    fprintf(stderr,"[map] GetStringUTFChars=%d GetStringUTFLength=%d GetStringChars=%d "
        "NewStringUTF=%d AllocObject=%d NewByteArray=%d CallStaticVoidMethod=%d CallVoidMethod=%d\n",
        OFF(GetStringUTFChars),OFF(GetStringUTFLength),OFF(GetStringChars),
        OFF(NewStringUTF),OFF(AllocObject),OFF(NewByteArray),OFF(CallStaticVoidMethod),OFF(CallVoidMethod));
}

typedef jint (*OnLoad)(JavaVM*, void*);
typedef void (*v_s)(JNIEnv*, jclass, jstring);
typedef void (*v_v)(JNIEnv*, jclass);
typedef jint (*i_ctx)(JNIEnv*, jclass, jobject);
typedef jint (*i_sssss)(JNIEnv*, jclass, jstring, jstring, jstring, jstring);
typedef jint (*i_s)(JNIEnv*, jclass, jstring);
typedef jint (*i_si)(JNIEnv*, jclass, jstring, jint);

static void*sym(void*h,const char*n){ void*p=dlsym(h,n); fprintf(stderr,"[sym] %-60s %s\n",n,p?"ok":"MISSING"); return p; }

int main(int argc,char**argv){
    if(argc<4){ fprintf(stderr,"usage: %s UID user pwd\n",argv[0]); return 2; }
    const char*uid=argv[1],*user=argv[2],*pwd=argv[3];
    build_tables();
    g_env_ptr = &g_env;
    install_segv();
    setvbuf(stderr,NULL,_IONBF,0);

    void*h=dlopen("libobject_jni.so", RTLD_NOW|RTLD_GLOBAL);
    if(!h){ fprintf(stderr,"dlopen failed: %s\n", dlerror()); return 1; }
    fprintf(stderr,"[ok] libobject_jni.so loaded\n");

    OnLoad onload=(OnLoad)dlsym(h,"JNI_OnLoad");
    if(onload){ jint v=onload(&g_vm,NULL); fprintf(stderr,"[ok] JNI_OnLoad -> 0x%x\n",v); }

    i_ctx    pSetCb = (i_ctx)   sym(h,"Java_object_p2pipcam_nativecaller_NativeCaller_PPPPSetCallbackContext");
    v_s      pInit  = (v_s)     sym(h,"Java_object_p2pipcam_nativecaller_NativeCaller_PPPPInitial");
    v_v      pInit2 = (v_v)     sym(h,"Java_object_p2pipcam_nativecaller_NativeCaller_Init");
    typedef jint (*i_v)(JNIEnv*,jclass);
    i_v      pNet   = (i_v)     sym(h,"Java_object_p2pipcam_nativecaller_NativeCaller_PPPPNetworkDetect");
    i_sssss  pStart = (i_sssss) sym(h,"Java_object_p2pipcam_nativecaller_NativeCaller_StartPPPP");
    i_s      pChk   = (i_s)     sym(h,"Java_object_p2pipcam_nativecaller_NativeCaller_PPPPCheckDevOnline");
    i_si     pLive  = (i_si)    sym(h,"Java_object_p2pipcam_nativecaller_NativeCaller_StartPPPPLivestream");

    const char*initarg = (argc>4)? argv[4] : "test";          // PPPPInitial arg
    const char*srvarg  = (argc>5)? argv[5] :                   // StartPPPP server arg (encoded)
                         "EBGAEIBIKHJJGFJJEEHOFAENHLNBHGNMHMFDAADAAOJNKNKG";
    Str jsrv={T_STR,strdup(initarg)}, juid={T_STR,strdup(uid)}, juser={T_STR,strdup(user)}, jpwd={T_STR,strdup(pwd)};
    Str jsrvstr={T_STR,strdup(srvarg)};
    const char*accUser=getenv("XIOT_ACC_USER"), *accPwd=getenv("XIOT_ACC_PWD");
    fprintf(stderr,"[cfg] initArg=%s srvArg=%.16s... account=%s\n", initarg, srvarg,
            (accUser&&*accUser)?"provided":"none");

    if(pInit)  { pInit(&g_env,NULL,(jstring)&jsrv); fprintf(stderr,"[ok] PPPPInitial(test)\n"); }
    if(pInit2) { pInit2(&g_env,NULL); fprintf(stderr,"[ok] Init\n"); }
    // TODO(Task 1 Step 3): account login (BZUserLogin/RegistAppInfo) using accUser/accPwd
    //   to obtain relay authorization before StartPPPP. Until implemented, a
    //   NAT'd host stalls at CONNECT_TIMEOUT(7). accUser/accPwd read above.
    (void)accUser; (void)accPwd;
    if(pNet)   { jint r=pNet(&g_env,NULL); fprintf(stderr,"[ok] PPPPNetworkDetect -> %d\n",r); }
    if(pSetCb) { jint r=pSetCb(&g_env,NULL,(jobject)&g_ctx); fprintf(stderr,"[ok] SetCallbackContext -> %d\n",r); }
    typedef jint (*i_s2)(JNIEnv*,jclass,jstring);
    i_s2 pStop = (i_s2) dlsym(h,"Java_object_p2pipcam_nativecaller_NativeCaller_StopPPPP");
    if(pStart) { jint r=pStart(&g_env,NULL,(jstring)&juid,(jstring)&juser,(jstring)&jpwd,(jstring)&jsrvstr);
                 fprintf(stderr,"[ok] StartPPPP -> %d\n",r); }
    if(pChk)   { jint r=pChk(&g_env,NULL,(jstring)&juid); fprintf(stderr,"[ok] PPPPCheckDevOnline -> %d\n",r); }

    int stype = atoi(getenv("XIOT_STREAM")?:"1");
    int started=0, lastretry=0;
    long lastframes=0; int laststall=0;
    for(int s=0;;s++){
        if(g_online && !started && pLive){
            jint r=pLive(&g_env,NULL,(jstring)&juid,stype);
            fprintf(stderr,"[ok] StartPPPPLivestream(%d) on ON_LINE -> %d\n",stype,r);
            started=1; lastframes=g_frames; laststall=s;
        }
        // retry the P2P connect every ~15s while not online (handles transient
        // DEVICE_NOT_ON_LINE(6)/CONNECT_TIMEOUT(7)/flapping)
        if(!g_online && !started && pStart && s-lastretry>=15 && s>0){
            fprintf(stderr,"[retry] re-StartPPPP at t=%ds\n",s);
            if(pStop) pStop(&g_env,NULL,(jstring)&juid);
            pStart(&g_env,NULL,(jstring)&juid,(jstring)&juser,(jstring)&jpwd,(jstring)&jsrvstr);
            if(pChk) pChk(&g_env,NULL,(jstring)&juid);
            lastretry=s;
        }
        sleep(1);
        if(s%10==0) fprintf(stderr,"[..] t=%ds online=%d started=%d frames=%ld bytes=%ld heals=%ld\n",
                           s,g_online,started,g_frames,g_vbytes,g_heals);
        // stall watchdog: once the livestream started, a 15s gap with no new
        // frame means the session died — exit non-zero so the supervisor
        // restarts us (reconnect). Before ON_LINE we keep waiting/retrying.
        if(started){
            if(g_frames>lastframes){ lastframes=g_frames; laststall=s; }
            else if(s-laststall>=15){
                fprintf(stderr,"[stall] no video for %ds after %ld frames — exiting for restart\n",
                        s-laststall, g_frames);
                return 4;
            }
        }
    }
}
