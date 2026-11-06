"""Compile the engine's complete shaders and sample actual offscreen GLES pixels."""
import ctypes as C
import json
import sys


def api(lib, name, result, *args):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = result, list(args)
    return fn


I, U, P, F = C.c_int, C.c_uint, C.c_void_p, C.c_float
try:
    egl, gl = C.CDLL("libEGL.so.1"), C.CDLL("libGLESv2.so.2")
    address = api(egl, "eglGetProcAddress", P, C.c_char_p)(b"eglGetPlatformDisplayEXT")
    if not address:
        sys.exit(77)
    display = C.CFUNCTYPE(P, U, P, P)(address)(0x31DD, None, None)
    if not api(egl, "eglInitialize", U, P, P, P)(display, None, None):
        sys.exit(77)
    if not api(egl, "eglBindAPI", U, U)(0x30A0):
        sys.exit(77)
    config, count = P(), I()
    attrs = (I * 13)(0x3033, 1, 0x3040, 0x40, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, 0x3038)
    if not api(egl, "eglChooseConfig", U, P, P, P, I, P)(display, attrs, C.byref(config), 1, C.byref(count)) or not count.value:
        sys.exit(77)
    context = api(egl, "eglCreateContext", P, P, P, P, P)(display, config, None, (I * 3)(0x3098, 3, 0x3038))
    surface = api(egl, "eglCreatePbufferSurface", P, P, P, P)(display, config, (I * 5)(0x3057, 8, 0x3056, 8, 0x3038))
    if not api(egl, "eglMakeCurrent", U, P, P, P, P)(display, surface, surface, context):
        sys.exit(77)
except (OSError, AttributeError):
    sys.exit(77)


def shader(kind, source):
    handle = api(gl, "glCreateShader", U, U)(kind)
    text = C.c_char_p(source.encode())
    api(gl, "glShaderSource", None, U, I, P, P)(handle, 1, C.byref(text), None)
    api(gl, "glCompileShader", None, U)(handle)
    status = I()
    api(gl, "glGetShaderiv", None, U, U, P)(handle, 0x8B81, C.byref(status))
    if not status.value:
        log = C.create_string_buffer(8192)
        api(gl, "glGetShaderInfoLog", None, U, I, P, P)(handle, len(log), None, log)
        raise AssertionError(log.value.decode())
    return handle


def texture(unit, values, floating=False):
    handle = U()
    api(gl, "glGenTextures", None, I, P)(1, C.byref(handle))
    api(gl, "glActiveTexture", None, U)(0x84C0 + unit)
    api(gl, "glBindTexture", None, U, U)(0x0DE1, handle)
    for key, value in [(0x2801, 0x2600), (0x2800, 0x2600), (0x2802, 0x812F), (0x2803, 0x812F)]:
        api(gl, "glTexParameteri", None, U, U, I)(0x0DE1, key, value)
    data = ((F if floating else C.c_ubyte) * 4)(*values)
    api(gl, "glTexImage2D", None, U, I, I, I, I, I, U, U, P)(0x0DE1, 0, 0x8814 if floating else 0x8058, 1, 1, 0, 0x1908, 0x1406 if floating else 0x1401, data)


texture(0, [255, 255, 255, 255])
texture(1, [0, 1, 1, 0], True)
api(gl, "glViewport", None, I, I, I, I)(0, 0, 8, 8)
checks = []
for source in json.load(sys.stdin):
    program = api(gl, "glCreateProgram", U)()
    for kind, name in [(0x8B31, "vertex"), (0x8B30, "fragment")]:
        api(gl, "glAttachShader", None, U, U)(program, shader(kind, source[name]))
    api(gl, "glLinkProgram", None, U)(program)
    status = I()
    api(gl, "glGetProgramiv", None, U, U, P)(program, 0x8B82, C.byref(status))
    if not status.value:
        log = C.create_string_buffer(8192)
        api(gl, "glGetProgramInfoLog", None, U, I, P, P)(program, len(log), None, log)
        raise AssertionError(log.value.decode())
    attributes = I()
    api(gl, "glGetProgramiv", None, U, U, P)(program, 0x8B89, C.byref(attributes))
    api(gl, "glUseProgram", None, U)(program)

    def uniform(name, values, integer=False):
        loc = api(gl, "glGetUniformLocation", I, U, C.c_char_p)(program, name.encode())
        if integer:
            api(gl, "glUniform1i", None, I, I)(loc, values[0])
        elif len(values) == 16:
            api(gl, "glUniformMatrix4fv", None, I, I, C.c_ubyte, P)(loc, 1, False, (F * 16)(*values))
        else:
            api(gl, "glUniform" + str(len(values)) + "fv", None, I, I, P)(loc, 1, (F * len(values))(*values))

    def attribute(name, values):
        loc = api(gl, "glGetAttribLocation", I, U, C.c_char_p)(program, name.encode())
        if loc >= 0:
            api(gl, "glDisableVertexAttribArray", None, U)(loc)
            api(gl, "glVertexAttrib4fv", None, U, P)(loc, (F * 4)(*(values + [0] * (4 - len(values)))))

    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    for name, values in {
        "modelMatrix": identity, "projectionMatrix": identity,
        "modelViewMatrix": [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
        "cameraPosition": [0, 2, 0], "uAtlasSize": [1, 1], "uColumns": [1], "uCell": [1],
        "uInner": [1], "uPadding": [0], "uAnimationWidth": [1],
        "uVerticalShade": [1, .5], "uFogNear": [96], "uFogFar": [220]
    }.items():
        uniform(name, values)
    uniform("uAtlas", [0], True)
    uniform("uAnimation", [1], True)
    for name, values in {"aOrigin": [-1, 0, -1], "aSize": [2, 2], "aFace": [2], "aMaterial": [0, 0, 0],
                         "aUvU": [0, 1, 0], "aUvV": [0, 0, 1], "color": [1, 1, 1],
                         "aTint1": [1, 1, 1], "aTint2": [1, 1, 1], "aTint3": [1, 1, 1]}.items():
        attribute(name, values)
    position = api(gl, "glGetAttribLocation", I, U, C.c_char_p)(program, b"position")
    buffer = U()
    api(gl, "glGenBuffers", None, I, P)(1, C.byref(buffer))
    api(gl, "glBindBuffer", None, U, U)(0x8892, buffer)
    vertices = (F * 18)(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0)
    api(gl, "glBufferData", None, U, C.c_ssize_t, P, U)(0x8892, C.sizeof(vertices), vertices, 0x88E4)
    api(gl, "glEnableVertexAttribArray", None, U)(position)
    api(gl, "glVertexAttribPointer", None, U, I, U, C.c_ubyte, I, P)(position, 3, 0x1406, False, 0, None)

    def sample(flags=0, occlusion=0):
        attribute("aMaterial", [0, flags, occlusion])
        api(gl, "glClear", None, U)(0x4000)
        api(gl, "glDrawArrays", None, U, I, I)(4, 0, 6)
        pixel = (C.c_ubyte * 4)()
        api(gl, "glReadPixels", None, I, I, I, I, U, U, P)(4, 4, 1, 1, 0x1908, 0x1401, pixel)
        assert api(gl, "glGetError", U)() == 0
        assert pixel[3] == 255
        return list(pixel)[:3]

    check = {"attributes": attributes.value, "surface": sample(),
             "occluded": sample(0, 255), "emissive": sample(8, 255)}
    attribute("color", [1, 0, 0])
    attribute("aTint1", [0, 1, 0])
    attribute("aTint2", [1, 0, 0])
    attribute("aTint3", [0, 1, 0])
    check["tinted"] = sample()
    for name in ["color", "aTint1", "aTint2", "aTint3"]:
        attribute(name, [1, 1, 1])
    attribute("aSize", [.01, .01])
    attribute("aAxisU", [2, .5, 0])
    attribute("aAxisV", [0, 0, 2])
    check["inclined"] = sample(8 | 32 | 64)
    checks.append(check)
print(json.dumps(checks))
